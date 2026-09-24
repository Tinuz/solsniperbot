import type { Config } from '../config.js'

export interface ExitInput {
  /** Realizable value per token now vs. entry cost per token, as a % gain. */
  gainPct: number
  /** Highest `gainPct` seen since entry. */
  peakGainPct: number
  ageMs: number
  /** Time since the last trade on this coin. */
  idleMs: number
  devSold: boolean
  /** Number of take-profit tiers already executed. */
  tiersDone: number
}

export type ExitDecision =
  | { action: 'hold' }
  | { action: 'sell'; pct: number; reason: string; urgent: boolean; tier?: number }

/**
 * Pure exit policy. Protective exits (dev dump, stop loss, trailing stop) win
 * over profit-taking; time-based exits come last.
 *
 * Gains are measured on what the remaining tokens would actually fetch if sold
 * now (curve impact and fees included), not on spot price, so a thin curve
 * cannot trigger a take-profit that the sell would not realize.
 */
export function decideExit(x: ExitInput, e: Config['exits']): ExitDecision {
  if (e.exitOnDevSell && x.devSold) return { action: 'sell', pct: 100, reason: 'dev sold', urgent: true }

  if (e.stopLossPct > 0 && x.gainPct <= -e.stopLossPct) {
    return { action: 'sell', pct: 100, reason: `stop loss ${x.gainPct.toFixed(1)}%`, urgent: true }
  }

  if (e.trailingStopPct > 0 && x.peakGainPct >= e.trailingArmPct) {
    const peakValue = 1 + x.peakGainPct / 100
    const value = 1 + x.gainPct / 100
    const drawdownPct = ((peakValue - value) / peakValue) * 100
    if (drawdownPct >= e.trailingStopPct) {
      return {
        action: 'sell',
        pct: 100,
        reason: `trailing stop: ${drawdownPct.toFixed(1)}% off peak +${x.peakGainPct.toFixed(1)}%`,
        urgent: true,
      }
    }
  }

  const tier = e.takeProfit[x.tiersDone]
  if (tier && x.gainPct >= tier.gainPct) {
    const last = x.tiersDone === e.takeProfit.length - 1
    return {
      action: 'sell',
      pct: last ? 100 : tier.sellPct,
      reason: `take profit +${x.gainPct.toFixed(1)}% (tier ${x.tiersDone + 1})`,
      urgent: false,
      tier: x.tiersDone,
    }
  }

  if (e.maxHoldMs > 0 && x.ageMs >= e.maxHoldMs) return { action: 'sell', pct: 100, reason: 'max hold time', urgent: false }
  if (e.staleMs > 0 && x.idleMs >= e.staleMs) return { action: 'sell', pct: 100, reason: 'no trading activity', urgent: false }
  return { action: 'hold' }
}
