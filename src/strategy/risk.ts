import { EventEmitter } from 'node:events'
import type { Config } from '../config.js'
import { lamportsToSol } from '../config.js'
import { DebouncedWriter, readJson } from '../util/persist.js'
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

interface SavedRisk {
  day: string
  realizedTodayLamports: string
  paused: boolean
  pauseReason?: string
}

/** Pauses owned by survival, which decides again at every start whether they still hold. */
const isDeathPause = (reason?: string) => reason?.startsWith('dead') ?? false

/**
 * Hard limits on activity that no strategy signal can override. Balance and
 * trade sizing are owned by `Survival`.
 *
 * With a `path`, the day's realized P&L and any pause are saved, and loaded
 * before trading starts: a crash, a supervisor restart or a deploy never
 * lifts the daily loss limit or a pause set by hand.
 */
export class RiskManager extends EventEmitter<{ alert: [string] }> {
  private paused = false
  private pauseReason?: string
  private day = utcDay()
  private realizedToday = 0n
  private readonly buys = new RateWindow(60_000)
  private readonly store?: DebouncedWriter

  constructor(
    private readonly cfg: Config,
    private readonly path?: string,
    onError: (err: unknown) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {
    super()
    this.day = utcDay(now())
    if (path) this.store = new DebouncedWriter(path, () => this.saved(), 100, onError)
  }

  /** Restores today's P&L and any pause (call before trading starts). */
  async load(): Promise<void> {
    if (!this.path) return
    const s = await readJson<SavedRisk>(this.path).catch(() => undefined)
    if (!s) return
    this.day = s.day
    this.realizedToday = BigInt(s.realizedTodayLamports)
    if (s.paused && !isDeathPause(s.pauseReason)) {
      this.paused = true
      this.pauseReason = s.pauseReason
    }
    // Saved on an earlier day: that day's P&L and daily-limit pause end with it.
    this.rollDay()
  }

  async flush(): Promise<void> {
    await this.store?.close()
  }

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
    this.store?.schedule()
    const limit = this.cfg.risk.dailyLossLimitLamports
    if (limit > 0n && this.realizedToday <= -limit && !this.paused) {
      this.pause(`daily loss limit hit (${lamportsToSol(this.realizedToday).toFixed(3)} SOL)`)
      this.emit('alert', `🛑 daily loss limit hit (${lamportsToSol(this.realizedToday).toFixed(3)} SOL today): buying paused until 00:00 UTC; open positions are still managed`)
    }
  }

  pause(reason = 'manual'): void {
    this.paused = true
    this.pauseReason = reason
    this.store?.schedule()
  }

  resume(): void {
    this.paused = false
    this.pauseReason = undefined
    this.store?.schedule()
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

  private saved(): SavedRisk {
    const keep = this.paused && !isDeathPause(this.pauseReason)
    return { day: this.day, realizedTodayLamports: this.realizedToday.toString(), paused: keep, pauseReason: keep ? this.pauseReason : undefined }
  }

  private rollDay(): void {
    const today = utcDay(this.now())
    if (today === this.day) return
    this.day = today
    this.realizedToday = 0n
    if (this.pauseReason?.startsWith('daily loss limit')) this.resume()
    this.store?.schedule()
  }
}
