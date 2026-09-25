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
  /** The position is down to its moonbag (a free ride). */
  moonbag?: boolean
  /** What the moonbag rules need to know about the money so far; without it no moonbag starts. */
  books?: PositionBooks
  /** Every moonbag slot is taken: no new moonbag, the normal rules sell everything. */
  moonbagsFull?: boolean
}

export interface PositionBooks {
  /** Share of the bought tokens still held, 0-1. */
  heldFraction: number
  /** Paid for the tokens, trade fees included. */
  costLamports: number
  /** Received from sells so far, after trade fees. */
  realizedLamports: number
  /** Network fees paid so far (tips, priority and base fees). */
  networkLamports: number
  /** Network fee of one sell transaction. */
  sellNetworkLamports: number
}

export type ExitDecision =
  | { action: 'hold' }
  | { action: 'sell'; pct: number; reason: string; urgent: boolean; tier?: number; moonbag?: boolean }
  /** What is held already is the moonbag and the rest is paid for: switch to the moonbag rules without selling. */
  | { action: 'moonbag'; reason: string }

type Moonbag = Config['exits']['moonbag']

/** Below this share of the bought tokens, selling down to the moonbag is not worth a transaction. */
const MIN_FREE_RIDE_SELL = 0.01

/**
 * Pure exit policy. Protective exits (dev dump, stop loss) win over
 * everything; then the free ride, trailing stop and profit-taking; time-based
 * exits come last. A moonbag follows its own, looser rules.
 *
 * Gains are measured on what the remaining tokens would actually fetch if sold
 * now (curve impact and fees included), not on spot price, so a thin curve
 * cannot trigger a take-profit that the sell would not realize.
 */
export function decideExit(x: ExitInput, e: Config['exits']): ExitDecision {
  if (x.moonbag) return decideMoonbag(x, e)
  if (e.exitOnDevSell && x.devSold) return { action: 'sell', pct: 100, reason: 'dev sold', urgent: true }

  if (e.stopLossPct > 0 && x.gainPct <= -e.stopLossPct) {
    return { action: 'sell', pct: 100, reason: `stop loss ${x.gainPct.toFixed(1)}%`, urgent: true }
  }

  const ride = x.moonbagsFull ? undefined : freeRide(x, e.moonbag)
  if (ride !== undefined) {
    const reason = `free ride at +${x.gainPct.toFixed(1)}%: stake, fees and ${e.moonbag.securePct}% profit secured, ${e.moonbag.pct}% moonbag rides`
    return ride > 0 ? { action: 'sell', pct: ride, reason, urgent: false, moonbag: true } : { action: 'moonbag', reason }
  }

  if (e.trailingStopPct > 0 && x.peakGainPct >= e.trailingArmPct) {
    const drawdownPct = drawdown(x)
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

/**
 * The moonbag is paid for; these rules only decide when to cash it: back at
 * entry (plus a buffer and the sell's own fee), well off its peak, too old,
 * or the dev sold. No stale exit: runners pause.
 */
function decideMoonbag(x: ExitInput, e: Config['exits']): ExitDecision {
  const m = e.moonbag
  if (e.exitOnDevSell && x.devSold) return { action: 'sell', pct: 100, reason: 'moonbag: dev sold', urgent: true }
  const floor = moonbagFloorPct(x.books, m)
  if (x.gainPct <= floor) return { action: 'sell', pct: 100, reason: `moonbag stop at +${floor.toFixed(1)}%`, urgent: true }
  if (m.trailingPct > 0) {
    const drawdownPct = drawdown(x)
    if (drawdownPct >= m.trailingPct) {
      return { action: 'sell', pct: 100, reason: `moonbag trailing stop: ${drawdownPct.toFixed(1)}% off peak +${x.peakGainPct.toFixed(1)}%`, urgent: true }
    }
  }
  if (m.maxHoldMs > 0 && x.ageMs >= m.maxHoldMs) return { action: 'sell', pct: 100, reason: 'moonbag max hold time', urgent: false }
  return { action: 'hold' }
}

/** Gain % at which the moonbag is sold: the buffer plus what the sell itself costs, relative to what the moonbag cost. */
export function moonbagFloorPct(books: PositionBooks | undefined, m: Moonbag): number {
  const costHeld = books ? books.costLamports * books.heldFraction : 0
  const feePct = books && costHeld > 0 ? (books.sellNetworkLamports / costHeld) * 100 : 0
  return m.stopBufferPct + feePct
}

/**
 * Percentage of the held tokens to sell so that only the moonbag remains,
 * when that sale would bring back the stake, every fee (including the later
 * sale of the moonbag) and the secured profit; 0 when what is held is already
 * no more than the moonbag and the rest is paid for; undefined when not yet.
 *
 * Proceeds are estimated from the value of selling everything held, which a
 * partial sale (less price impact) only beats.
 */
export function freeRide(x: Pick<ExitInput, 'gainPct' | 'books'>, m: Moonbag): number | undefined {
  const b = x.books
  if (!b || !(m.pct > 0) || !(b.heldFraction > 0) || !(b.costLamports > 0)) return undefined
  const keep = m.pct / 100
  const sellFraction = b.heldFraction - keep >= MIN_FREE_RIDE_SELL ? b.heldFraction - keep : 0
  const proceeds = sellFraction * b.costLamports * (1 + x.gainPct / 100)
  const sells = sellFraction > 0 ? 2 : 1
  const needed = b.costLamports * (1 + m.securePct / 100) + b.networkLamports + sells * b.sellNetworkLamports
  if (b.realizedLamports + proceeds < needed) return undefined
  return sellFraction > 0 ? (sellFraction / b.heldFraction) * 100 : 0
}

function drawdown(x: Pick<ExitInput, 'gainPct' | 'peakGainPct'>): number {
  const peakValue = 1 + x.peakGainPct / 100
  const value = 1 + x.gainPct / 100
  return ((peakValue - value) / peakValue) * 100
}
