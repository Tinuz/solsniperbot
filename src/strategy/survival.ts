import { join } from 'node:path'
import type { Config } from '../config.js'
import { lamportsToSol } from '../config.js'
import { feeSchedule, minViableBuyLamports } from '../trading/fees.js'
import { type Position, positionPnl } from '../trading/positions.js'
import type { Logger } from '../util/logger.js'
import { readJson, writeJsonAtomic } from '../util/persist.js'

export type VitalState = 'healthy' | 'defensive' | 'critical' | 'dead'

export interface Vitals {
  state: VitalState
  reason: string
  /** Wallet balance (live) or paper wallet balance; null when unknown. */
  balanceLamports: bigint | null
  /** Balance plus the realizable value of open positions. */
  equityLamports: bigint | null
  peakEquityLamports: bigint
  drawdownPct: number
  /** Most a new buy may spend after the exit reserve and upfront costs. */
  affordableLamports: bigint
  /** Size of the next buy; 0 when the bot cannot afford a viable trade. */
  nextBuyLamports: bigint
  /** Smallest trade worth making once round-trip network costs are counted. */
  minViableBuyLamports: bigint
  /** Balance needed to open that smallest viable trade. */
  revivalLamports: bigint
  /** How many minimum-size trades the free balance can still fund. */
  runwayTrades: number
}

// The fee arithmetic lives with the other fees; config checks it at startup too.
export { BUY_ACCOUNT_OVERHEAD_LAMPORTS, feeSchedule, minViableBuyLamports } from '../trading/fees.js'

interface SurvivalFile {
  version: 1
  peakEquityLamports: string
  paper?: { startLamports: string; realizedLamports: string }
  dead?: { reason: string; at: number; balanceLamports: string | null }
}

/** Thrown at startup when the bot is dead and still cannot afford to trade. */
export class DeadError extends Error {}

const sol = (l: bigint) => `${lamportsToSol(l).toFixed(4)} SOL`

/**
 * Keeps the bot solvent. Trade size scales with the bankroll, an exit reserve
 * is never spent, trades too small to beat their own fees are refused, and
 * when the wallet can no longer fund a viable trade (with nothing left to
 * sell) the bot declares itself dead and shuts down instead of bleeding the
 * rest away.
 *
 * Paper mode runs the same logic against a simulated wallet, so survival can
 * be tested without funds.
 */
export class Survival {
  private peak = 0n
  private paperStart = 0n
  private paperRealized = 0n
  private dead?: SurvivalFile['dead']
  private deathSince?: number
  private deathChecks = 0
  private deathHandler?: (v: Vitals) => void
  private persisting: Promise<void> = Promise.resolve()
  readonly path: string

  constructor(
    private readonly cfg: Config,
    private readonly log: Logger,
    /** A death condition must persist this long (and across 2 checks) before it is final. */
    private readonly confirmMs = 5_000,
  ) {
    this.path = join(cfg.dataDir, `survival-${cfg.dryRun ? 'paper' : 'live'}.json`)
  }

  private get paper(): boolean {
    return this.cfg.dryRun
  }

  async load(): Promise<void> {
    const saved = await readJson<SurvivalFile>(this.path)
    const reset = this.paper && this.cfg.survival.paperReset
    if (!saved || reset) {
      this.paperStart = this.cfg.survival.paperStartLamports
      this.paperRealized = 0n
      this.peak = this.paper ? this.paperStart : 0n
      this.dead = undefined
      if (reset) this.log.warn({ startSol: lamportsToSol(this.paperStart) }, 'paper wallet reset')
      await this.persist()
      return
    }
    this.peak = BigInt(saved.peakEquityLamports)
    this.dead = saved.dead
    if (saved.paper) {
      this.paperStart = BigInt(saved.paper.startLamports)
      this.paperRealized = BigInt(saved.paper.realizedLamports)
    } else {
      this.paperStart = this.cfg.survival.paperStartLamports
    }
  }

  onDeath(handler: (v: Vitals) => void): void {
    this.deathHandler = handler
  }

  get isDead(): boolean {
    return this.dead !== undefined
  }

  get deathReason(): string | undefined {
    return this.dead?.reason
  }

  /** Paper wallet: starting capital + realized P&L + cash flows of open positions. */
  paperBalance(open: readonly Position[]): bigint {
    let balance = this.paperStart + this.paperRealized
    for (const p of open) balance += p.realizedLamports - p.costLamports - p.networkFeesLamports
    return balance
  }

  /** Paper: P&L booked since the paper wallet was (re)started. */
  get paperRealizedLamports(): bigint {
    return this.paperRealized
  }

  /** Books a finished paper position into the paper wallet. */
  bookClosed(pos: Position): void {
    if (!this.paper || !pos.paper) return
    this.paperRealized += positionPnl(pos)
    void this.persist()
  }

  /** Pure evaluation; no side effects. */
  compute(input: { walletLamports: bigint | null; open: readonly Position[] }): Vitals {
    const cfg = this.cfg
    const fees = feeSchedule(cfg)
    const minViable = minViableBuyLamports(cfg)
    const reserve = cfg.risk.minReserveLamports
    const revival = minViable + fees.buyUpfront + reserve
    const balance = this.paper ? this.paperBalance(input.open) : input.walletLamports
    const base = { minViableBuyLamports: minViable, revivalLamports: revival, peakEquityLamports: this.peak }

    if (balance === null) {
      return {
        ...base,
        state: 'critical',
        reason: 'wallet balance unknown',
        balanceLamports: null,
        equityLamports: null,
        drawdownPct: 0,
        affordableLamports: 0n,
        nextBuyLamports: 0n,
        runwayTrades: 0,
      }
    }

    const openValue = input.open.reduce((sum, p) => sum + p.valueLamports, 0n)
    const equity = balance + openValue
    const peak = equity > this.peak ? equity : this.peak
    const drawdownPct = peak > 0n ? Number(((peak - equity) * 10_000n) / peak) / 100 : 0
    const free = balance - reserve
    const affordable = free - fees.buyUpfront > 0n ? free - fees.buyUpfront : 0n

    let desired =
      cfg.survival.sizing === 'fixed'
        ? cfg.buyLamports
        : (free * BigInt(Math.round(cfg.survival.buyFractionPct * 100))) / 10_000n
    if (desired > cfg.buyLamports) desired = cfg.buyLamports
    const defensive = cfg.survival.defensiveDrawdownPct > 0 && drawdownPct >= cfg.survival.defensiveDrawdownPct
    if (defensive) desired /= 2n
    // A small bankroll trades at the smallest viable size rather than not at
    // all, but never above BUY_SOL: that is the most the owner allows per trade
    // (loadConfig refuses a BUY_SOL below the smallest viable size).
    if (desired < minViable) desired = minViable
    const size = minViable > cfg.buyLamports ? 0n : desired <= affordable ? desired : affordable >= minViable ? affordable : 0n
    const runway = free > 0n ? Number(free / (minViable + fees.buyUpfront)) : 0

    let state: VitalState
    let reason: string
    const openCount = input.open.length
    if (balance <= 0n) {
      state = 'dead'
      reason = 'wallet is empty'
    } else if (openCount > 0 && balance < fees.sellNetwork * BigInt(openCount)) {
      state = 'dead'
      reason = `cannot pay the fees to exit ${openCount} open position(s)`
    } else if (size === 0n) {
      if (openCount > 0) {
        state = 'critical'
        reason = `too little free SOL for a new trade (needs ${sol(revival)}); waiting on ${openCount} open position(s)`
      } else {
        state = 'dead'
        reason = `insufficient funds to trade: ${sol(balance)} left, a viable trade needs ${sol(revival)}`
      }
    } else if (defensive) {
      state = 'defensive'
      reason = `drawdown ${drawdownPct.toFixed(1)}% from peak: trade size halved`
    } else {
      state = 'healthy'
      reason = 'ok'
    }

    return {
      ...base,
      state,
      reason,
      balanceLamports: balance,
      equityLamports: equity,
      peakEquityLamports: peak,
      drawdownPct,
      affordableLamports: affordable,
      nextBuyLamports: state === 'dead' ? 0n : size,
      runwayTrades: runway,
    }
  }

  /**
   * Periodic check with side effects: tracks peak equity and declares death
   * once a fatal condition has held for `confirmMs` over at least two checks
   * while no transaction is in flight (a pending buy is not a lost balance).
   */
  check(input: { walletLamports: bigint | null; open: readonly Position[]; busy: boolean }, now = Date.now()): Vitals {
    const v = this.compute(input)
    if (this.dead) {
      return { ...v, state: 'dead', reason: this.dead.reason, nextBuyLamports: 0n }
    }
    if (v.equityLamports !== null && v.equityLamports > this.peak) {
      this.peak = v.equityLamports
      void this.persist()
    }
    if (v.state !== 'dead') {
      this.deathChecks = 0
      this.deathSince = undefined
      return v
    }
    if (input.busy) return { ...v, state: 'critical', reason: `${v.reason} (transactions in flight)` }
    this.deathChecks++
    this.deathSince ??= now
    if (this.deathChecks < 2 || now - this.deathSince < this.confirmMs) {
      return { ...v, state: 'critical', reason: `${v.reason} (confirming)` }
    }
    this.dead = { reason: v.reason, at: now, balanceLamports: v.balanceLamports?.toString() ?? null }
    void this.persist()
    this.log.fatal({ reason: v.reason, balanceSol: v.balanceLamports === null ? null : lamportsToSol(v.balanceLamports) }, 'bot is dead')
    this.deathHandler?.(v)
    return v
  }

  /**
   * Startup gate for a bot that died earlier: it comes back only if the wallet
   * can fund a viable trade again (e.g. the owner topped it up).
   */
  reviveOrThrow(input: { walletLamports: bigint | null; open: readonly Position[] }): void {
    if (!this.dead) return
    const v = this.compute(input)
    if (v.nextBuyLamports > 0n && v.state !== 'dead') {
      this.log.warn({ previousDeath: this.dead.reason, balanceSol: v.balanceLamports === null ? null : lamportsToSol(v.balanceLamports) }, 'revived: the wallet can fund trades again')
      this.dead = undefined
      this.peak = v.equityLamports ?? 0n
      void this.persist()
      return
    }
    const how = this.paper
      ? 'Set PAPER_RESET=true to start a new paper wallet'
      : `Fund the wallet to at least ${sol(v.revivalLamports)} to revive it`
    throw new DeadError(`bot is dead since ${new Date(this.dead.at).toISOString()}: ${this.dead.reason}. ${how}.`)
  }

  flush(): Promise<void> {
    return this.persisting
  }

  private persist(): Promise<void> {
    const snapshot: SurvivalFile = {
      version: 1,
      peakEquityLamports: this.peak.toString(),
      paper: this.paper ? { startLamports: this.paperStart.toString(), realizedLamports: this.paperRealized.toString() } : undefined,
      dead: this.dead,
    }
    this.persisting = this.persisting
      .then(() => writeJsonAtomic(this.path, snapshot))
      .catch((err) => this.log.error({ err }, 'failed to persist survival state'))
    return this.persisting
  }
}
