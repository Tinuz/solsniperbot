import { join } from 'node:path'
import type { Launch } from '../feed/market.js'
import type { TradeEvent } from '../pump/events.js'
import type { Position } from '../trading/positions.js'
import { positionPnl } from '../trading/positions.js'
import type { Logger } from '../util/logger.js'
import { Journal } from '../util/persist.js'
import { type LaunchRecord, type LaunchVerdict, type TradeRow, summarize } from './record.js'
import { type WalletEntry, earlyBuys } from './wallets.js'

interface Active {
  rec: Omit<LaunchRecord, 'summary'>
  wallets: Map<string, number>
}

export interface RecorderOptions {
  dataDir: string
  horizonMs: number
  maxTrades: number
  /** Cap on launches being recorded at once, to bound memory. */
  maxActive?: number
  /** Wallets never logged as early buyers (the bot's own). */
  ignoreWallets?: string[]
  /** Called with each finished launch's early buyers (see `wallets.ts`). */
  onWallets?: (e: WalletEntry) => void
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10)
/** Past RECORD_MAX_TRADES: keep a row at least this often... */
const THIN_MS = 1_000
/** ...and whenever the price moved this much since the last kept row. */
const THIN_MOVE = 0.02
/** Hard cap on rows, as a multiple of RECORD_MAX_TRADES. */
const THIN_CAP_FACTOR = 4
const num = (v: bigint) => Number(v)

/**
 * Records every SOL-paired launch (bought or not) with its decision features
 * and its trades for a fixed horizon, into `data/launches/<day>.jsonl`.
 *
 * Rejected launches are the most valuable rows: they show whether each filter
 * actually avoided losers, which the bot's own trades can never tell you.
 * Recording happens after decisions are made, so it adds no latency.
 */
export class LaunchRecorder {
  private readonly active = new Map<string, Active>()
  private readonly journals = new Map<string, Journal>()
  private readonly maxActive: number
  private readonly ignore: ReadonlySet<string>
  private written = 0
  private dropped = 0

  constructor(
    private readonly opts: RecorderOptions,
    private readonly log: Logger,
  ) {
    this.maxActive = opts.maxActive ?? 20_000
    this.ignore = new Set(opts.ignoreWallets ?? [])
  }

  start(
    launch: Launch,
    extra: {
      verdict: LaunchVerdict
      reason: string
      creatorLaunches: number
      feeBps: { protocol: bigint; creator: bigint }
      tokenOffset: bigint
      initialRealTokenReserves: bigint
      settings?: string
    },
  ): void {
    if (!launch.isSolPaired || this.active.has(launch.mintStr)) return
    if (this.active.size >= this.maxActive) {
      if (this.dropped++ % 1000 === 0) this.log.warn({ active: this.active.size }, 'launch recorder at capacity; skipping launches')
      return
    }
    const c = launch.curve
    const dev = launch.dev.toBase58()
    this.active.set(launch.mintStr, {
      wallets: new Map([[dev, 0]]),
      rec: {
        v: 1,
        mint: launch.mintStr,
        name: launch.name,
        symbol: launch.symbol,
        uri: launch.uri,
        dev,
        creator: launch.creator.toBase58(),
        tokenProgram: launch.tokenProgram.toBase58(),
        mayhem: launch.isMayhemMode,
        holderReward: launch.isHolderReward,
        source: launch.source,
        executed: launch.executed,
        slot: launch.slot,
        t: launch.detectedAtWall,
        curve: { vq: num(c.virtualQuoteReserves), vt: num(c.virtualTokenReserves), rt: num(c.realTokenReserves), supply: num(c.tokenTotalSupply) },
        tokenOffset: num(extra.tokenOffset),
        initialRt: num(extra.initialRealTokenReserves),
        devBuyLamports: num(launch.devBuyLamports),
        devBuyTokens: num(launch.devBuyTokens),
        creatorLaunches: extra.creatorLaunches,
        feeBps: { protocol: num(extra.feeBps.protocol), creator: num(extra.feeBps.creator) },
        verdict: extra.verdict,
        reason: extra.reason,
        ...(extra.settings ? { settings: extra.settings } : {}),
        trades: [],
        truncated: false,
        graduated: false,
        partial: false,
        horizonMs: this.opts.horizonMs,
      },
    })
  }

  verdict(mint: string, verdict: LaunchVerdict, reason: string): void {
    const a = this.active.get(mint)
    if (!a) return
    a.rec.verdict = verdict
    a.rec.reason = reason
  }

  trade(ev: TradeEvent): void {
    const a = this.active.get(ev.mint.toBase58())
    if (!a) return
    const rec = a.rec
    if (rec.truncated) return
    const user = ev.user.toBase58()
    let wallet = a.wallets.get(user)
    if (wallet === undefined) {
      wallet = a.wallets.size
      a.wallets.set(user, wallet)
    }
    const row: TradeRow = [Date.now() - rec.t, num(ev.virtualSolReserves), num(ev.virtualTokenReserves), ev.isBuy ? 1 : -1, num(ev.solAmount), wallet]
    if (rec.trades.length >= this.opts.maxTrades) {
      // Past the cap, keep the price path: enough to replay exits on a runner, far fewer rows.
      if (rec.trades.length >= this.opts.maxTrades * THIN_CAP_FACTOR) {
        rec.truncated = true
        return
      }
      const last = rec.trades[rec.trades.length - 1]!
      const move = Math.abs(row[1] / row[2] / (last[1] / last[2]) - 1)
      if (wallet !== 0 && row[0] - last[0] < THIN_MS && move < THIN_MOVE) {
        rec.skippedTrades = (rec.skippedTrades ?? 0) + 1
        return
      }
      rec.thinnedFrom ??= rec.trades.length
    }
    rec.trades.push(row)
  }

  complete(mint: string): void {
    const a = this.active.get(mint)
    if (a) a.rec.graduated = true
  }

  /** Links the bot's own result for this coin, if it traded it. */
  position(pos: Position): void {
    const a = this.active.get(pos.mint)
    if (!a) return
    a.rec.position = {
      paper: pos.paper,
      costLamports: num(pos.costLamports),
      pnlLamports: num(positionPnl(pos)),
      exits: pos.status === 'failed' ? [`buy failed: ${pos.error ?? ''}`] : pos.sells.map((s) => s.reason),
      holdMs: (pos.closedAt ?? Date.now()) - pos.openedAt,
      slotsAfterLaunch: pos.slotsAfterLaunch,
    }
  }

  /** Writes out launches whose horizon has passed. */
  tick(now = Date.now()): void {
    for (const [mint, a] of this.active) {
      if (now - a.rec.t >= this.opts.horizonMs) this.finish(mint, a, false)
    }
  }

  /** Writes everything still open (marked partial), e.g. on shutdown. */
  async flush(): Promise<void> {
    for (const [mint, a] of this.active) this.finish(mint, a, true)
    await Promise.all([...this.journals.values()].map((j) => j.flush()))
  }

  stats() {
    return { recording: this.active.size, written: this.written }
  }

  private finish(mint: string, a: Active, partial: boolean): void {
    this.active.delete(mint)
    const rec: LaunchRecord = { ...a.rec, partial, summary: summarize(a.rec) }
    const d = day(rec.t)
    void this.journal('launches', d).append(rec)
    this.written++
    // Early buyers and how their buys turned out (a cut-short recording has no outcome yet).
    if (partial) return
    const addresses: string[] = []
    for (const [address, index] of a.wallets) addresses[index] = address
    const buys = earlyBuys(rec, addresses, this.ignore)
    if (!buys.length) return
    const entry: WalletEntry = { mint, t: rec.t, until: rec.t + rec.horizonMs, buys }
    void this.journal('wallets', d).append(entry)
    this.opts.onWallets?.(entry)
  }

  private journal(kind: 'launches' | 'wallets', d: string): Journal {
    const key = `${kind}/${d}`
    let journal = this.journals.get(key)
    if (!journal) {
      journal = new Journal(join(this.opts.dataDir, kind, `${d}.jsonl`), (err) => this.log.error({ err, kind }, 'failed to write recording'))
      this.journals.set(key, journal)
      // Keep only the current and previous day's handles of each kind.
      for (const k of [...this.journals.keys()].filter((x) => x.startsWith(`${kind}/`)).sort().slice(0, -2)) this.journals.delete(k)
    }
    return journal
  }
}
