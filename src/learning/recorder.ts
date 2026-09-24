import { join } from 'node:path'
import type { Launch } from '../feed/market.js'
import type { TradeEvent } from '../pump/events.js'
import type { Position } from '../trading/positions.js'
import { positionPnl } from '../trading/positions.js'
import type { Logger } from '../util/logger.js'
import { Journal } from '../util/persist.js'
import { type LaunchRecord, type LaunchVerdict, summarize } from './record.js'

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
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10)
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
  private written = 0
  private dropped = 0

  constructor(
    private readonly opts: RecorderOptions,
    private readonly log: Logger,
  ) {
    this.maxActive = opts.maxActive ?? 20_000
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
    if (rec.trades.length >= this.opts.maxTrades) {
      rec.truncated = true
      return
    }
    const user = ev.user.toBase58()
    let wallet = a.wallets.get(user)
    if (wallet === undefined) {
      wallet = a.wallets.size
      a.wallets.set(user, wallet)
    }
    rec.trades.push([
      Date.now() - rec.t,
      num(ev.virtualSolReserves),
      num(ev.virtualTokenReserves),
      ev.isBuy ? 1 : -1,
      num(ev.solAmount),
      wallet,
    ])
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
    let journal = this.journals.get(d)
    if (!journal) {
      journal = new Journal(join(this.opts.dataDir, 'launches', `${d}.jsonl`), (err) =>
        this.log.error({ err }, 'failed to write launch record'),
      )
      this.journals.set(d, journal)
      // Keep only the current and previous day's handles.
      for (const k of [...this.journals.keys()].sort().slice(0, -2)) this.journals.delete(k)
    }
    void journal.append(rec)
    this.written++
  }
}
