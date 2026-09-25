import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { PublicKey } from '@solana/web3.js'
import type { Config } from '../config.js'
import { lamportsToSol } from '../config.js'
import type { MarketBook, MintState } from '../feed/market.js'
import { curveFromAccount, feeRates, quoteSell } from '../pump/curve.js'
import { decodeBondingCurve } from '../pump/layouts.js'
import { bondingCurvePda } from '../pump/pda.js'
import type { PumpProtocol } from '../pump/protocol.js'
import type { RpcClient } from '../solana/rpc.js'
import { type ExitDecision, type PositionBooks, decideExit } from '../strategy/exits.js'
import type { RiskManager } from '../strategy/risk.js'
import type { Logger } from '../util/logger.js'
import { DebouncedWriter, Journal, readJson } from '../util/persist.js'
import type { BuyRequest, Executor, SimulationReport, Timings, TradeResult } from './executor.js'

export type PositionStatus = 'opening' | 'open' | 'closing' | 'closed' | 'failed'

export interface SellRecord {
  at: number
  tokens: bigint
  lamports: bigint
  signature: string
  reason: string
}

export interface Position {
  mint: string
  name: string
  symbol: string
  tokenProgram: string
  creator: string
  dev?: string
  isMayhemMode: boolean
  paper: boolean
  status: PositionStatus
  entryReason: string
  openedAt: number
  closedAt?: number
  launchSlot?: number
  entrySlot?: number
  /** Wall-clock time the buy filled. */
  filledAt?: number
  slotsAfterLaunch?: number
  buySignature?: string
  /** Lamports paid for the tokens, trade fees included. */
  costLamports: bigint
  tokensBought: bigint
  tokensHeld: bigint
  /** Lamports received from sells, after trade fees. */
  realizedLamports: bigint
  /** Tips, priority fees and base fees (estimated until reconciled on-chain). */
  networkFeesLamports: bigint
  /** Exact net SOL change of the wallet across this position's transactions (live only). */
  walletDeltaLamports?: bigint
  /** Landed transactions, and how many of them have been reconciled on-chain. */
  landedTxs: number
  reconciledTxs: number
  reconciled: boolean
  /** P&L already booked into the totals (adjusted when reconciliation lands later). */
  bookedPnlLamports?: bigint
  tiersDone: number
  /** Down to its moonbag: stake, fees and a profit are secured, the rest rides (see MOONBAG_PCT). */
  moonbag?: boolean
  moonbagAt?: number
  gainPct: number
  peakGainPct: number
  valueLamports: bigint
  lastPriceAt: number
  sells: SellRecord[]
  sellAttempts: number
  /** Backoff after a failed sell cycle so a stuck exit doesn't spin every tick. */
  nextSellAt: number
  closeReason?: string
  error?: string
  timings?: Timings
  simulation?: SimulationReport
}

export interface PositionStats {
  closed: number
  wins: number
  losses: number
  netPnlLamports: bigint
  bestPnlLamports: bigint
  worstPnlLamports: bigint
  avgHoldMs: number
}

const BASE_FEE = 5_000n

/** Net P&L: realized + current value - cost - network fees. */
export function positionPnl(p: Position): bigint {
  if (p.reconciled && p.walletDeltaLamports !== undefined) return p.walletDeltaLamports + p.valueLamports
  return p.realizedLamports + p.valueLamports - p.costLamports - p.networkFeesLamports
}

interface Deps {
  cfg: Config
  executor: Executor
  market: MarketBook
  protocol: PumpProtocol
  risk: RiskManager
  rpc: RpcClient
  log: Logger
}

export interface OpenRequest extends BuyRequest {
  name: string
  symbol: string
  dev?: string
  reason: string
  launchSlot?: number
}

/**
 * Owns every position from buy to close: live repricing on each trade,
 * exit decisions, sells with escalating-slippage retries, persistence and
 * P&L booking.
 */
export class PositionManager extends EventEmitter<{ update: [Position]; closed: [Position] }> {
  private readonly active = new Map<string, Position>()
  private readonly recent: Position[] = []
  private readonly selling = new Set<string>()
  private readonly journal: Journal
  private readonly store: DebouncedWriter
  private readonly totals: PositionStats = {
    closed: 0,
    wins: 0,
    losses: 0,
    netPnlLamports: 0n,
    bestPnlLamports: 0n,
    worstPnlLamports: 0n,
    avgHoldMs: 0,
  }
  private timer?: NodeJS.Timeout

  constructor(private readonly d: Deps) {
    super()
    const onError = (err: unknown) => d.log.error({ err }, 'failed to persist positions')
    this.journal = new Journal(join(d.cfg.dataDir, 'trades.jsonl'), onError)
    this.store = new DebouncedWriter(join(d.cfg.dataDir, 'positions.json'), () => [...this.active.values()], 200, onError)
  }

  // Lifecycle -----------------------------------------------------------------

  async start(): Promise<void> {
    await this.restore()
    this.timer = setInterval(() => this.tick(), 1_000)
  }

  async stop(): Promise<void> {
    clearInterval(this.timer)
    await this.store.flush()
    await this.journal.flush()
  }

  has(mint: string): boolean {
    return this.active.has(mint)
  }

  get(mint: string): Position | undefined {
    return this.active.get(mint)
  }

  /** Positions that count against MAX_OPEN_POSITIONS: moonbags don't, they have their own limit. */
  get openCount(): number {
    let n = 0
    for (const p of this.active.values()) if (!p.moonbag) n++
    return n
  }

  get moonbagCount(): number {
    return this.active.size - this.openCount
  }

  list(): Position[] {
    return [...this.active.values()]
  }

  history(): Position[] {
    return this.recent.slice()
  }

  stats(): PositionStats {
    return { ...this.totals }
  }

  // Entry ---------------------------------------------------------------------

  async open(req: OpenRequest): Promise<Position> {
    const mint = req.mint.toBase58()
    const pos: Position = {
      mint,
      name: req.name,
      symbol: req.symbol,
      tokenProgram: req.tokenProgram.toBase58(),
      creator: req.creator.toBase58(),
      dev: req.dev,
      isMayhemMode: req.isMayhemMode,
      paper: this.d.executor.paper,
      status: 'opening',
      entryReason: req.reason,
      openedAt: Date.now(),
      launchSlot: req.launchSlot,
      costLamports: req.lamports,
      tokensBought: 0n,
      tokensHeld: 0n,
      realizedLamports: 0n,
      networkFeesLamports: 0n,
      landedTxs: 0,
      reconciledTxs: 0,
      reconciled: false,
      tiersDone: 0,
      gainPct: 0,
      peakGainPct: 0,
      valueLamports: 0n,
      lastPriceAt: 0,
      sells: [],
      sellAttempts: 0,
      nextSellAt: 0,
    }
    this.active.set(mint, pos)
    this.d.risk.recordBuy()
    this.changed(pos)

    const result = await this.d.executor.buy(req)
    if (!result.ok) {
      pos.status = 'failed'
      pos.error = result.error
      pos.buySignature = result.signature
      pos.timings = result.timings
      pos.closedAt = Date.now()
      pos.costLamports = 0n
      // A buy that executed and failed still paid its network fee (tips only move on success).
      if (result.landed) pos.networkFeesLamports = BASE_FEE + this.d.cfg.buyPriorityLamports
      this.finish(pos)
      void this.journal.append({ type: 'buy-failed', at: Date.now(), mint, error: result.error, signature: result.signature, paper: pos.paper })
      return pos
    }

    this.applyBuy(pos, req, result)
    return pos
  }

  private applyBuy(pos: Position, req: OpenRequest, r: Extract<TradeResult, { ok: true }>): void {
    pos.status = 'open'
    pos.buySignature = r.signature
    pos.filledAt = Date.now()
    pos.entrySlot = r.slot
    pos.slotsAfterLaunch = req.launchSlot && r.slot ? r.slot - req.launchSlot : undefined
    pos.tokensBought = r.tokens
    pos.tokensHeld = r.tokens
    pos.costLamports = r.lamports > 0n ? r.lamports : req.lamports
    pos.networkFeesLamports += this.estimatedNetworkFee('buy')
    pos.timings = r.timings
    pos.simulation = r.simulation
    pos.lastPriceAt = Date.now()
    if (!pos.paper) this.markLanded(pos)
    if (pos.tokensHeld === 0n) {
      pos.status = 'failed'
      pos.error = 'buy landed but token balance could not be determined; check the wallet manually'
      this.finish(pos)
      return
    }
    const state = this.d.market.get(pos.mint)
    if (state) state.watched = true
    this.reprice(pos)
    this.d.log.info(
      {
        mint: pos.mint,
        symbol: pos.symbol,
        paper: pos.paper,
        sol: lamportsToSol(pos.costLamports),
        tokens: Number(pos.tokensBought) / 1e6,
        slotsAfterLaunch: pos.slotsAfterLaunch,
        buildMs: r.timings.buildMs.toFixed(2),
        sendMs: r.timings.sendMs.toFixed(1),
        landMs: r.timings.landMs?.toFixed(0),
      },
      'position opened',
    )
    void this.journal.append({ type: 'buy', at: Date.now(), mint: pos.mint, symbol: pos.symbol, paper: pos.paper, signature: r.signature, lamports: pos.costLamports, tokens: pos.tokensBought, slot: r.slot, slotsAfterLaunch: pos.slotsAfterLaunch, timings: r.timings, simulation: r.simulation })
    if (!pos.paper) void this.reconcile(pos, r.signature)
    this.changed(pos)
  }

  // Monitoring ----------------------------------------------------------------

  /** Called for every trade on a mint (from the market book). */
  onMarket(state: MintState): void {
    const pos = this.active.get(state.mintStr)
    if (!pos || pos.status !== 'open') return
    this.reprice(pos, state)
    this.evaluate(pos, state)
  }

  private tick(): void {
    for (const pos of this.active.values()) {
      if (pos.status !== 'open') continue
      const state = this.d.market.get(pos.mint)
      this.reprice(pos, state)
      this.evaluate(pos, state)
    }
  }

  private reprice(pos: Position, state = this.d.market.get(pos.mint)): void {
    if (!state || pos.tokensHeld === 0n || pos.tokensBought === 0n) return
    if (state.complete) return // curve reserves are frozen at graduation
    const q = quoteSell(state.curve, feeRates(this.d.protocol.feeContext(), state.curve), pos.tokensHeld)
    const costHeld = (pos.costLamports * pos.tokensHeld) / pos.tokensBought
    pos.valueLamports = q.quoteOut
    pos.gainPct = costHeld > 0n ? (Number(q.quoteOut) / Number(costHeld) - 1) * 100 : 0
    if (pos.gainPct > pos.peakGainPct) pos.peakGainPct = pos.gainPct
    pos.lastPriceAt = Date.now()
    this.emit('update', pos)
  }

  private evaluate(pos: Position, state: MintState | undefined): void {
    const now = Date.now()
    if (this.selling.has(pos.mint) || now < pos.nextSellAt) return
    let decision: ExitDecision
    if (state?.complete) {
      decision = { action: 'sell', pct: 100, reason: 'graduated to PumpSwap', urgent: true }
    } else {
      decision = decideExit(
        {
          gainPct: pos.gainPct,
          peakGainPct: pos.peakGainPct,
          ageMs: now - pos.openedAt,
          idleMs: state ? now - state.lastTradeAtWall : now - pos.lastPriceAt,
          devSold: state?.devSold ?? false,
          tiersDone: pos.tiersDone,
          moonbag: pos.moonbag,
          books: this.books(pos),
          moonbagsFull: !pos.moonbag && this.moonbagCount >= this.d.cfg.exits.moonbag.max,
        },
        this.d.cfg.exits,
      )
    }
    if (decision.action === 'moonbag') {
      this.startMoonbag(pos, decision.reason)
      this.evaluate(pos, state)
    } else if (decision.action === 'sell') {
      void this.sell(pos.mint, decision.pct, decision.reason, decision.tier, decision.moonbag)
    }
  }

  private books(pos: Position): PositionBooks | undefined {
    if (pos.tokensBought === 0n) return undefined
    return {
      heldFraction: Number(pos.tokensHeld) / Number(pos.tokensBought),
      costLamports: Number(pos.costLamports),
      realizedLamports: Number(pos.realizedLamports),
      networkLamports: Number(pos.networkFeesLamports),
      sellNetworkLamports: Number(this.estimatedNetworkFee('sell')),
    }
  }

  private startMoonbag(pos: Position, reason: string): void {
    pos.moonbag = true
    pos.moonbagAt = Date.now()
    this.d.log.info({ mint: pos.mint, symbol: pos.symbol, reason, heldPct: Math.round((Number(pos.tokensHeld) / Number(pos.tokensBought || 1n)) * 100) }, 'moonbag riding')
    void this.journal.append({ type: 'moonbag', at: pos.moonbagAt, mint: pos.mint, symbol: pos.symbol, paper: pos.paper, reason, tokens: pos.tokensHeld })
    this.changed(pos)
  }

  // Exit ----------------------------------------------------------------------

  /**
   * Sells `pct` of the remaining position, retrying with wider slippage.
   * With `moonbag`, what remains afterwards rides as the moonbag.
   */
  async sell(mint: string, pct: number, reason: string, tier?: number, moonbag = false): Promise<boolean> {
    const pos = this.active.get(mint)
    if (!pos || pos.status !== 'open' || this.selling.has(mint)) return false
    this.selling.add(mint)
    pos.status = 'closing'
    this.changed(pos)
    const { exits } = this.d.cfg
    try {
      const all = pct >= 100
      let tokens = all ? pos.tokensHeld : (pos.tokensHeld * BigInt(Math.round(pct * 100))) / 10_000n
      // Don't leave dust behind a partial sell.
      if (!all && pos.tokensHeld - tokens < pos.tokensBought / 100n) tokens = pos.tokensHeld
      if (tokens <= 0n) return false
      const sellingAll = tokens === pos.tokensHeld
      let migrationWaits = 0

      for (let attempt = 0; attempt <= exits.sellRetries; attempt++) {
        const slippageBps =
          exits.sellRetries === 0
            ? exits.sellSlippageBps
            : Math.round(exits.sellSlippageBps + ((exits.sellMaxSlippageBps - exits.sellSlippageBps) * attempt) / exits.sellRetries)
        const graduated = this.d.market.get(mint)?.complete ?? false
        pos.sellAttempts++
        const result = await this.d.executor.sell({
          mint: new PublicKey(mint),
          tokenProgram: new PublicKey(pos.tokenProgram),
          creator: new PublicKey(this.d.market.get(mint)?.curve.creator ?? pos.creator),
          isMayhemMode: pos.isMayhemMode,
          tokens,
          slippageBps,
          // Only on the first attempt: a stray dust transfer would make the close fail.
          closeAccount: sellingAll && exits.closeTokenAccount && attempt === 0 && !graduated,
        })
        if (result.ok) {
          await this.applySell(pos, tokens, result, reason, tier, moonbag)
          return true
        }

        this.d.log.warn({ mint, symbol: pos.symbol, attempt, slippageBps, error: result.error }, 'sell attempt failed')
        if (result.landed) pos.networkFeesLamports += BASE_FEE + this.d.cfg.sellPriorityLamports
        if (pos.paper && graduated) {
          // Paper mode cannot route through the AMM: book at the last curve value.
          await this.applySell(pos, tokens, { ok: true, paper: true, signature: 'paper-graduated', slot: 0, tokens, lamports: pos.valueLamports, tradeFeesLamports: 0n, timings: { buildMs: 0, sendMs: 0 } }, reason, tier, moonbag)
          return true
        }
        if (/Pool account not found/i.test(result.error) && migrationWaits < 30) {
          // Migration to PumpSwap not finished yet; wait and retry without using up attempts.
          migrationWaits++
          await new Promise((r) => setTimeout(r, 2_000))
          attempt--
          continue
        }
        if (!pos.paper && !result.slippage) {
          // Unknown failure: re-sync the balance in case tokens moved.
          const onChain = await this.d.executor.tokenBalance(new PublicKey(mint), new PublicKey(pos.tokenProgram)).catch(() => undefined)
          if (onChain === 0n) {
            pos.tokensHeld = 0n
            pos.valueLamports = 0n
            this.close(pos, `${reason} (tokens no longer in wallet)`)
            return false
          }
          if (onChain !== undefined && onChain < tokens) tokens = onChain
        }
      }
      pos.status = 'open'
      pos.error = `sell failed after ${exits.sellRetries + 1} attempts`
      // Back off before the exit policy retries: 2s, 4s, ... capped at 30s.
      const failures = Math.ceil(pos.sellAttempts / (exits.sellRetries + 1))
      pos.nextSellAt = Date.now() + Math.min(30_000, 2_000 * 2 ** Math.max(0, failures - 1))
      this.changed(pos)
      return false
    } finally {
      this.selling.delete(mint)
      if (pos.status === 'closing') {
        pos.status = 'open'
        this.changed(pos)
      }
    }
  }

  async sellAll(reason: string): Promise<void> {
    await Promise.all(this.list().filter((p) => p.status === 'open').map((p) => this.sell(p.mint, 100, reason)))
  }

  private async applySell(pos: Position, tokens: bigint, r: Extract<TradeResult, { ok: true }>, reason: string, tier?: number, moonbag = false): Promise<void> {
    let lamports = r.lamports
    if (lamports === 0n && !r.paper) {
      // Fill was not seen on the stream; book the expected proceeds until reconciled.
      lamports = (pos.valueLamports * tokens) / (pos.tokensHeld || 1n)
    }
    pos.tokensHeld -= tokens
    pos.realizedLamports += lamports
    pos.networkFeesLamports += this.estimatedNetworkFee('sell')
    pos.sells.push({ at: Date.now(), tokens, lamports, signature: r.signature, reason })
    if (!r.paper) this.markLanded(pos)
    if (tier !== undefined) pos.tiersDone = tier + 1
    pos.error = undefined
    this.d.log.info({ mint: pos.mint, symbol: pos.symbol, reason, sol: lamportsToSol(lamports), tokens: Number(tokens) / 1e6, paper: pos.paper }, 'sold')
    void this.journal.append({ type: 'sell', at: Date.now(), mint: pos.mint, symbol: pos.symbol, paper: pos.paper, signature: r.signature, lamports, tokens, reason, timings: r.timings, simulation: r.simulation })
    if (!r.paper) void this.reconcile(pos, r.signature)
    if (pos.tokensHeld <= 0n) {
      pos.tokensHeld = 0n
      pos.valueLamports = 0n
      this.close(pos, reason)
    } else {
      pos.status = 'open'
      this.reprice(pos)
      if (moonbag && !pos.moonbag) this.startMoonbag(pos, reason)
      this.changed(pos)
    }
  }

  private close(pos: Position, reason: string): void {
    pos.status = 'closed'
    pos.closeReason = reason
    pos.closedAt = Date.now()
    this.finish(pos)
  }

  private finish(pos: Position): void {
    this.active.delete(pos.mint)
    this.d.market.unwatch(pos.mint)
    this.recent.unshift(pos)
    if (this.recent.length > 200) this.recent.pop()
    // Closed positions, and failed live buys (which still paid network fees), hit P&L.
    if (pos.status === 'closed' || pos.networkFeesLamports > 0n) {
      const pnl = positionPnl(pos)
      pos.bookedPnlLamports = pnl
      this.d.risk.recordRealized(pnl)
      this.totals.closed++
      if (pnl > 0n) this.totals.wins++
      else this.totals.losses++
      this.totals.netPnlLamports += pnl
      if (pnl > this.totals.bestPnlLamports) this.totals.bestPnlLamports = pnl
      if (pnl < this.totals.worstPnlLamports) this.totals.worstPnlLamports = pnl
      const held = (pos.closedAt ?? Date.now()) - pos.openedAt
      this.totals.avgHoldMs += (held - this.totals.avgHoldMs) / this.totals.closed
      if (pos.status === 'closed') {
        this.d.log.info({ mint: pos.mint, symbol: pos.symbol, reason: pos.closeReason, pnlSol: lamportsToSol(pnl), paper: pos.paper }, 'position closed')
        void this.journal.append({ type: 'close', at: Date.now(), mint: pos.mint, symbol: pos.symbol, paper: pos.paper, reason: pos.closeReason, pnlLamports: pnl, cost: pos.costLamports, realized: pos.realizedLamports, networkFees: pos.networkFeesLamports })
      }
    }
    this.store.schedule()
    this.emit('closed', pos)
  }

  // Accounting ----------------------------------------------------------------

  /** A new landed tx makes the wallet delta incomplete until it is reconciled too. */
  private markLanded(pos: Position): void {
    pos.landedTxs++
    pos.reconciled = pos.reconciledTxs >= pos.landedTxs
  }

  private estimatedNetworkFee(side: 'buy' | 'sell'): bigint {
    const c = this.d.cfg
    return side === 'buy' ? c.buyTipLamports + c.buyPriorityLamports + BASE_FEE : c.sellTipLamports + c.sellPriorityLamports + BASE_FEE
  }

  /**
   * Replaces estimates with the exact on-chain wallet delta once every landed
   * transaction is confirmed. If the position already closed, the booked P&L
   * (totals and daily risk) is corrected by the difference.
   */
  private async reconcile(pos: Position, signature: string): Promise<void> {
    const delta = await this.d.executor.walletDelta(signature)
    if (delta === undefined) {
      this.d.log.warn({ mint: pos.mint, signature }, 'could not reconcile transaction; P&L stays estimated')
      return
    }
    pos.walletDeltaLamports = (pos.walletDeltaLamports ?? 0n) + delta
    pos.reconciledTxs++
    pos.reconciled = pos.reconciledTxs >= pos.landedTxs
    if (pos.reconciled && pos.bookedPnlLamports !== undefined) {
      const exact = positionPnl(pos)
      const correction = exact - pos.bookedPnlLamports
      if (correction !== 0n) {
        const wasWin = pos.bookedPnlLamports > 0n
        this.totals.netPnlLamports += correction
        this.d.risk.recordRealized(correction)
        if (wasWin !== exact > 0n) {
          this.totals.wins += wasWin ? -1 : 1
          this.totals.losses += wasWin ? 1 : -1
        }
        pos.bookedPnlLamports = exact
        void this.journal.append({ type: 'reconcile', at: Date.now(), mint: pos.mint, pnlLamports: exact, correctionLamports: correction })
      }
    }
    this.changed(pos)
  }

  private changed(pos: Position): void {
    this.store.schedule()
    this.emit('update', pos)
  }

  // Restore -------------------------------------------------------------------

  /** Reloads open positions after a restart and re-seeds their live curve state. */
  private async restore(): Promise<void> {
    const saved = await readJson<Record<string, unknown>[]>(join(this.d.cfg.dataDir, 'positions.json'))
    if (!saved?.length) return
    for (const raw of saved) {
      const pos = reviveBigints(raw) as unknown as Position
      if (pos.paper !== this.d.executor.paper) continue
      if (pos.status === 'opening') {
        // Crashed mid-buy: trust the chain, not the file.
        const bal = await this.d.executor.tokenBalance(new PublicKey(pos.mint), new PublicKey(pos.tokenProgram)).catch(() => 0n)
        if (bal === 0n) continue
        pos.tokensBought = bal
        pos.tokensHeld = bal
      }
      pos.status = 'open'
      pos.nextSellAt = 0
      try {
        const acct = await this.d.rpc.getAccountInfo(bondingCurvePda(new PublicKey(pos.mint)))
        if (acct) {
          const curve = curveFromAccount(decodeBondingCurve(acct.data))
          this.d.market.seed(new PublicKey(pos.mint), curve, 0)
        }
      } catch (err) {
        this.d.log.warn({ mint: pos.mint, err: (err as Error).message }, 'could not refresh curve for restored position')
      }
      this.active.set(pos.mint, pos)
      this.d.log.info({ mint: pos.mint, symbol: pos.symbol }, 'restored open position')
    }
  }
}

const BIGINT_FIELDS = new Set([
  'costLamports',
  'tokensBought',
  'tokensHeld',
  'realizedLamports',
  'networkFeesLamports',
  'walletDeltaLamports',
  'bookedPnlLamports',
  'valueLamports',
  'tokens',
  'lamports',
])

/** Inverse of the JSON replacer for the bigint fields of persisted positions. */
function reviveBigints(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((v) => reviveBigints(v))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = reviveBigints(v, k)
    return out
  }
  if (typeof value === 'string' && BIGINT_FIELDS.has(key) && /^-?\d+$/.test(value)) return BigInt(value)
  return value
}
