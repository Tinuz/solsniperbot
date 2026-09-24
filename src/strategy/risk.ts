import type { Config } from '../config.js'
import { lamportsToSol } from '../config.js'
import { RateWindow } from '../util/time.js'
import type { Verdict } from './filters.js'

/** Rent for a Token-2022 ATA plus pump's one-time user volume accumulator, rounded up. */
export const BUY_ACCOUNT_OVERHEAD_LAMPORTS = 4_500_000n
const BASE_FEE_LAMPORTS = 5_000n

const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10)

export interface RiskSnapshot {
  paused: boolean
  pauseReason?: string
  day: string
  realizedTodayLamports: bigint
  buysLastMinute: number
}

/** Hard limits that no strategy signal can override. */
export class RiskManager {
  private paused = false
  private pauseReason?: string
  private day = utcDay()
  private realizedToday = 0n
  private readonly buys = new RateWindow(60_000)

  constructor(private readonly cfg: Config) {}

  /** Worst-case lamports a buy can consume beyond the buy size itself. */
  buyOverheadLamports(priorityLamports: bigint): bigint {
    return this.cfg.buyTipLamports + priorityLamports + BASE_FEE_LAMPORTS + BUY_ACCOUNT_OVERHEAD_LAMPORTS
  }

  canBuy(input: { openPositions: number; balanceLamports: bigint | null; sizeLamports: bigint; priorityLamports: bigint }): Verdict {
    this.rollDay()
    if (this.paused) return { pass: false, reason: `paused: ${this.pauseReason ?? 'manual'}` }
    if (input.openPositions >= this.cfg.risk.maxOpenPositions) {
      return { pass: false, reason: `max open positions (${this.cfg.risk.maxOpenPositions})` }
    }
    if (this.buys.count() >= this.cfg.risk.maxBuysPerMinute) return { pass: false, reason: 'buy rate limit' }
    if (!this.cfg.dryRun) {
      if (input.balanceLamports === null) return { pass: false, reason: 'wallet balance unknown' }
      const needed = input.sizeLamports + this.buyOverheadLamports(input.priorityLamports) + this.cfg.risk.minReserveLamports
      if (input.balanceLamports < needed) {
        return { pass: false, reason: `insufficient balance (${lamportsToSol(input.balanceLamports).toFixed(4)} SOL)` }
      }
    }
    return { pass: true }
  }

  recordBuy(): void {
    this.buys.add()
  }

  /** Books realized P&L and trips the daily loss limit if breached. */
  recordRealized(pnlLamports: bigint): void {
    this.rollDay()
    this.realizedToday += pnlLamports
    const limit = this.cfg.risk.dailyLossLimitLamports
    if (limit > 0n && this.realizedToday <= -limit && !this.paused) {
      this.pause(`daily loss limit hit (${lamportsToSol(this.realizedToday).toFixed(3)} SOL)`)
    }
  }

  pause(reason = 'manual'): void {
    this.paused = true
    this.pauseReason = reason
  }

  resume(): void {
    this.paused = false
    this.pauseReason = undefined
  }

  snapshot(): RiskSnapshot {
    this.rollDay()
    return {
      paused: this.paused,
      pauseReason: this.pauseReason,
      day: this.day,
      realizedTodayLamports: this.realizedToday,
      buysLastMinute: this.buys.count(),
    }
  }

  private rollDay(): void {
    const today = utcDay()
    if (today === this.day) return
    this.day = today
    this.realizedToday = 0n
    if (this.pauseReason?.startsWith('daily loss limit')) this.resume()
  }
}
