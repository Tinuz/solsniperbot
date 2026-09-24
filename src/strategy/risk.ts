import type { Config } from '../config.js'
import { lamportsToSol } from '../config.js'
import { RateWindow } from '../util/time.js'
import type { Verdict } from './filters.js'

const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10)

export interface RiskSnapshot {
  paused: boolean
  pauseReason?: string
  day: string
  realizedTodayLamports: bigint
  buysLastMinute: number
}

/**
 * Hard limits on activity that no strategy signal can override. Balance and
 * trade sizing are owned by `Survival`.
 */
export class RiskManager {
  private paused = false
  private pauseReason?: string
  private day = utcDay()
  private realizedToday = 0n
  private readonly buys = new RateWindow(60_000)

  constructor(private readonly cfg: Config) {}

  canBuy(input: { openPositions: number }): Verdict {
    this.rollDay()
    if (this.paused) return { pass: false, reason: `paused: ${this.pauseReason ?? 'manual'}` }
    if (input.openPositions >= this.cfg.risk.maxOpenPositions) {
      return { pass: false, reason: `max open positions (${this.cfg.risk.maxOpenPositions})` }
    }
    if (this.buys.count() >= this.cfg.risk.maxBuysPerMinute) return { pass: false, reason: 'buy rate limit' }
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
