import type { Config } from '../config.js'
import { type ExitDecision, decideExit } from '../strategy/exits.js'
import { EARLY_WINDOW_MS, type MomentumSnapshot, decideMomentum } from '../strategy/momentum.js'
import type { LaunchRecord } from './record.js'

export interface ReplayConfig {
  entry: 'instant' | 'momentum'
  momentum: Config['momentum']
  maxEntryMcapLamports: bigint
  exits: Config['exits']
  /** Detection-to-fill delay applied to every buy and sell. */
  latencyMs: number
  buyLamports: number
  buySlippageBps: number
  buyNetworkLamports: number
  sellNetworkLamports: number
}

export interface ReplayResult {
  entered: boolean
  skipReason?: string
  entryMs?: number
  /** Paid for tokens, trade fees included. */
  costLamports: number
  /** Received from sells, after trade fees. */
  proceedsLamports: number
  networkLamports: number
  pnlLamports: number
  pnlPct: number
  exits: string[]
  holdMs: number
  peakGainPct: number
}

export function replayConfigFrom(cfg: Config, over: Partial<ReplayConfig> = {}): ReplayConfig {
  const base = 5_000
  return {
    entry: cfg.entryMode,
    momentum: cfg.momentum,
    maxEntryMcapLamports: cfg.filters.maxEntryMcapLamports,
    exits: cfg.exits,
    latencyMs: cfg.paperLatencyMs,
    buyLamports: Number(cfg.buyLamports),
    buySlippageBps: cfg.buySlippageBps,
    buyNetworkLamports: Number(cfg.buyTipLamports + cfg.buyPriorityLamports) + base,
    sellNetworkLamports: Number(cfg.sellTipLamports + cfg.sellPriorityLamports) + base,
    ...over,
  }
}

// Float versions of the curve math. Reserves are below 2^53 so the only error
// is rounding in the last digit, far below anything that matters offline.

function buyTokens(vq: number, vt: number, rt: number, spend: number, pBps: number, cBps: number) {
  const net0 = Math.floor((spend * 10_000) / (10_000 + pBps + cBps))
  let net = net0
  const fees = Math.ceil((net * pBps) / 10_000) + Math.ceil((net * cBps) / 10_000)
  if (net + fees > spend) net -= net + fees - spend
  if (net <= 1) return { tokens: 0, into: 0 }
  const tokens = Math.min(Math.floor(((net - 1) * vt) / (vq + net - 1)), rt)
  return { tokens, into: Math.floor((tokens * vq) / (vt - tokens)) + 1 }
}

function sellQuote(vq: number, vt: number, tokens: number, pBps: number, cBps: number) {
  const gross = Math.floor((tokens * vq) / (vt + tokens))
  const fees = Math.ceil((gross * pBps) / 10_000) + Math.ceil((gross * cBps) / 10_000)
  return { gross, out: Math.max(0, gross - fees) }
}

/**
 * Replays one recorded launch through the bot's own entry and exit rules
 * (`decideMomentum`, `decideExit`) and returns what the trade would have made.
 *
 * Fills happen `latencyMs` after each decision, against the curve as it stood
 * then; the bot's own buy is overlaid on the recorded curve so its price
 * impact carries through to the exits. Time-based exits are evaluated at the
 * exact moment they trigger rather than on a polling grid.
 */
export function replayLaunch(rec: LaunchRecord, c: ReplayConfig): ReplayResult {
  const none = (skipReason: string): ReplayResult => ({
    entered: false, skipReason, costLamports: 0, proceedsLamports: 0, networkLamports: 0,
    pnlLamports: 0, pnlPct: 0, exits: [], holdMs: 0, peakGainPct: 0,
  })
  const { protocol: pBps, creator: cBps } = rec.feeBps
  const trades = rec.trades
  const end = rec.partial && trades.length ? trades[trades.length - 1]![0] : rec.horizonMs

  // Curve (and last trade index) as of time `t`.
  let cursor = -1
  const at = (t: number) => {
    while (cursor + 1 < trades.length && trades[cursor + 1]![0] <= t) cursor++
    const row = cursor >= 0 ? trades[cursor]! : undefined
    return { vq: row ? row[1] : rec.curve.vq, vt: row ? row[2] : rec.curve.vt, idx: cursor }
  }

  // Entry --------------------------------------------------------------------
  let decisionMs = 0
  if (c.entry === 'momentum') {
    const buyers = new Set<number>()
    // Net tokens per wallet: each row's reserves move by exactly the tokens traded.
    const holdings = new Map<number, number>()
    let lastVt = rec.curve.vt
    let top = 0
    let buys = 0
    let sells = 0
    let early = 0
    let devSold = false
    let i = 0
    let decided = false
    // Check at every trade and on a 250ms clock, like the live engine.
    for (let t = 0; t <= Math.min(c.momentum.maxAgeMs + 250, end); t += 250) {
      while (i < trades.length && trades[i]![0] <= t) {
        const [dt, , vtAfter, side, lamports, wallet] = trades[i]!
        const tokens = Math.abs(lastVt - vtAfter)
        lastVt = vtAfter
        if (side > 0) {
          buys += lamports
          if (wallet !== 0) {
            buyers.add(wallet)
            if (dt <= EARLY_WINDOW_MS) early += lamports
          }
        } else {
          sells += lamports
          if (wallet === 0) devSold = true
        }
        if (wallet !== 0) {
          const held = Math.max(0, (holdings.get(wallet) ?? 0) + side * tokens)
          holdings.set(wallet, held)
          if (held > top) top = held
          else if (side < 0) {
            top = 0
            for (const h of holdings.values()) if (h > top) top = h
          }
        }
        i++
      }
      const row = i > 0 ? trades[i - 1]! : undefined
      const vq = row ? row[1] : rec.curve.vq
      const vt = row ? row[2] : rec.curve.vt
      const snap: MomentumSnapshot = {
        ageMs: t,
        buyers: buyers.size,
        netBuyLamports: BigInt(Math.round(buys - sells)),
        sellRatio: buys > 0 ? sells / buys : 0,
        mcapLamports: BigInt(Math.round((vq * rec.curve.supply) / vt)),
        devSold,
        complete: false,
        earlyBuyLamports: BigInt(Math.round(early)),
        topBuyerPct: rec.curve.supply > 0 ? Math.floor((top / rec.curve.supply) * 1_000_000) / 10_000 : 0,
      }
      const d = decideMomentum(snap, c.momentum, c.maxEntryMcapLamports)
      if (d.action === 'reject') return none(d.reason)
      if (d.action === 'buy') {
        decisionMs = t
        decided = true
        break
      }
    }
    if (!decided) return none('momentum window expired')
  }

  const expected = at(decisionMs)
  const expectedTokens = buyTokens(expected.vq, expected.vt, expected.vt - rec.tokenOffset, c.buyLamports, pBps, cBps).tokens
  const minOut = Math.floor((expectedTokens * (10_000 - c.buySlippageBps)) / 10_000)
  const entryMs = decisionMs + c.latencyMs
  if (entryMs >= end) return none('recording ended before the fill')
  const fill = at(entryMs)
  const bought = buyTokens(fill.vq, fill.vt, fill.vt - rec.tokenOffset, c.buyLamports, pBps, cBps)
  if (bought.tokens <= 0 || bought.tokens < minOut) return none('slippage')

  // Our own buy shifts the curve; carry that through every later price.
  let dq = bought.into
  let dt = -bought.tokens
  let held = bought.tokens
  const cost = c.buyLamports
  let proceeds = 0
  let network = c.buyNetworkLamports
  let peak = 0
  let tiersDone = 0
  const exits: string[] = []
  let devSold = trades.some((r) => r[0] <= entryMs && r[3] < 0 && r[5] === 0)
  let lastTradeMs = fill.idx >= 0 ? trades[fill.idx]![0] : 0

  const gainAt = (vq: number, vt: number) => {
    const value = sellQuote(vq + dq, vt + dt, held, pBps, cBps).out
    const costHeld = (cost * held) / bought.tokens
    return (value / costHeld - 1) * 100
  }
  const sellAt = (t: number, pct: number, reason: string) => {
    const fillAt = Math.min(t + c.latencyMs, end)
    const s = at(fillAt)
    let amount = pct >= 100 ? held : Math.floor((held * pct) / 100)
    // Same dust rule as the live bot: never leave a sliver behind a partial sell.
    if (held - amount < bought.tokens / 100) amount = held
    const q = sellQuote(s.vq + dq, s.vt + dt, amount, pBps, cBps)
    proceeds += q.out
    network += c.sellNetworkLamports
    held -= amount
    dq -= q.gross
    dt += amount
    exits.push(reason)
    return fillAt
  }

  // Exit loop: decisions can only change at a trade (price, dev activity) or
  // when a time-based rule comes due. Max hold counts from the decision, as
  // the live bot's position age does.
  const maxHoldAt = c.exits.maxHoldMs > 0 ? decisionMs + c.exits.maxHoldMs : Number.POSITIVE_INFINITY
  let t = entryMs
  let i = fill.idx + 1
  let exitedAt = end
  let evaluatedAt = -1
  while (held > 0) {
    const nextTrade = i < trades.length ? trades[i]![0] : Number.POSITIVE_INFINITY
    let next = nextTrade
    const staleAt = c.exits.staleMs > 0 ? lastTradeMs + c.exits.staleMs : Number.POSITIVE_INFINITY
    for (const due of [maxHoldAt, staleAt]) {
      // A timer that fell due while a sell was in flight fires immediately.
      const when = Math.max(due, t)
      if (when < next && !(when === t && evaluatedAt === t)) next = when
    }
    if (next > end) break
    t = next
    if (t === nextTrade) {
      const row = trades[i]!
      if (row[3] < 0 && row[5] === 0) devSold = true
      lastTradeMs = row[0]
      i++
    }
    evaluatedAt = t
    const cur = at(t)
    const gain = gainAt(cur.vq, cur.vt)
    if (gain > peak) peak = gain
    const d: ExitDecision = decideExit(
      { gainPct: gain, peakGainPct: peak, ageMs: t - decisionMs, idleMs: t - lastTradeMs, devSold, tiersDone },
      c.exits,
    )
    if (d.action === 'sell') {
      const filled = sellAt(t, d.pct, d.reason)
      if (d.tier !== undefined) tiersDone = d.tier + 1
      // The live bot ignores new signals while a sell is in flight.
      while (i < trades.length && trades[i]![0] <= filled) {
        const row = trades[i]!
        if (row[3] < 0 && row[5] === 0) devSold = true
        lastTradeMs = row[0]
        i++
      }
      t = filled
      exitedAt = filled
    }
  }
  if (held > 0) {
    exitedAt = sellAt(end, 100, rec.graduated ? 'graduated' : 'recording ended') // mark to market
  }

  const pnl = proceeds - cost - network
  return {
    entered: true,
    entryMs,
    costLamports: cost,
    proceedsLamports: proceeds,
    networkLamports: network,
    pnlLamports: pnl,
    pnlPct: (pnl / cost) * 100,
    exits,
    holdMs: exitedAt - entryMs,
    peakGainPct: peak,
  }
}

export interface Summary {
  trades: number
  wins: number
  winRate: number
  totalPnlLamports: number
  meanPnlPct: number
  medianPnlPct: number
  maxDrawdownLamports: number
  avgHoldMs: number
}

/** Aggregates entered replays in chronological order (for drawdown). */
export function summarizeResults(results: readonly Pick<ReplayResult, 'entered' | 'pnlLamports' | 'pnlPct' | 'holdMs'>[]): Summary {
  const entered = results.filter((r) => r.entered)
  const pcts = entered.map((r) => r.pnlPct).sort((a, b) => a - b)
  let equity = 0
  let peak = 0
  let dd = 0
  for (const r of entered) {
    equity += r.pnlLamports
    if (equity > peak) peak = equity
    if (peak - equity > dd) dd = peak - equity
  }
  const wins = entered.filter((r) => r.pnlLamports > 0).length
  return {
    trades: entered.length,
    wins,
    winRate: entered.length ? wins / entered.length : 0,
    totalPnlLamports: equity,
    meanPnlPct: pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : 0,
    medianPnlPct: pcts.length ? pcts[Math.floor(pcts.length / 2)]! : 0,
    maxDrawdownLamports: dd,
    avgHoldMs: entered.length ? entered.reduce((a, r) => a + r.holdMs, 0) / entered.length : 0,
  }
}
