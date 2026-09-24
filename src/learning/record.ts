import type { FeedSource } from '../feed/types.js'

export type LaunchVerdict = 'rejected' | 'watching' | 'buying' | 'skipped'

/** `[msSinceDetection, virtualQuoteReserves, virtualTokenReserves, side (1 buy, -1 sell), lamports, wallet (0 = dev)]` */
export type TradeRow = [number, number, number, number, number, number]

export interface RecordSummary {
  trades: number
  buyers: number
  /** Price multiples relative to the spot price at detection. */
  maxMultiple: number
  tMaxMs: number
  minMultiple: number
  finalMultiple: number
  devSold: boolean
  devSoldAtMs?: number
  maxMcapSol: number
}

export interface RecordedPosition {
  paper: boolean
  costLamports: number
  pnlLamports: number
  exits: string[]
  holdMs: number
  slotsAfterLaunch?: number
}

/**
 * One launch as the bot saw it: the features it decided on, what it decided,
 * and how the coin actually traded afterwards. Numbers fit in doubles exactly
 * (reserves < 2^53), so records stay plain JSON.
 */
export interface LaunchRecord {
  v: 1
  mint: string
  name: string
  symbol: string
  uri: string
  dev: string
  creator: string
  tokenProgram: string
  mayhem: boolean
  holderReward: boolean
  source: FeedSource
  executed: boolean
  slot: number
  /** Wall-clock ms at detection. */
  t: number
  /** Curve at detection, after the create transaction's own buys. */
  curve: { vq: number; vt: number; rt: number; supply: number }
  /** virtual - real token reserves; constant per curve, used to rebuild real reserves. */
  tokenOffset: number
  /** Real token reserves of a fresh curve (for curve-progress filters). */
  initialRt: number
  devBuyLamports: number
  devBuyTokens: number
  creatorLaunches: number
  feeBps: { protocol: number; creator: number }
  verdict: LaunchVerdict
  reason: string
  /** `settingsFingerprint` of the entry/filter/exit settings in effect (newer records). */
  settings?: string
  position?: RecordedPosition
  trades: TradeRow[]
  /** Trade cap reached before the horizon. */
  truncated: boolean
  graduated: boolean
  /** Written before the horizon ended (bot shut down). */
  partial: boolean
  horizonMs: number
  summary: RecordSummary
}

export function summarize(rec: Pick<LaunchRecord, 'curve' | 'trades' | 'tokenOffset'>): RecordSummary {
  const p0 = rec.curve.vq / rec.curve.vt
  let max = 1
  let min = 1
  let tMax = 0
  let last = 1
  let maxMcap = (rec.curve.vq * rec.curve.supply) / rec.curve.vt
  let devSoldAt: number | undefined
  const buyers = new Set<number>()
  for (const [dt, vq, vt, side, , wallet] of rec.trades) {
    const m = vq / vt / p0
    last = m
    if (m > max) {
      max = m
      tMax = dt
    }
    if (m < min) min = m
    const mcap = (vq * rec.curve.supply) / vt
    if (mcap > maxMcap) maxMcap = mcap
    if (side > 0 && wallet !== 0) buyers.add(wallet)
    if (side < 0 && wallet === 0 && devSoldAt === undefined) devSoldAt = dt
  }
  return {
    trades: rec.trades.length,
    buyers: buyers.size,
    maxMultiple: max,
    tMaxMs: tMax,
    minMultiple: min,
    finalMultiple: last,
    devSold: devSoldAt !== undefined,
    devSoldAtMs: devSoldAt,
    maxMcapSol: maxMcap / 1e9,
  }
}
