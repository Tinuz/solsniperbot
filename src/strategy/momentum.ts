import type { Config } from '../config.js'
import { lamportsToSol } from '../config.js'
import { marketCapLamports } from '../pump/curve.js'
import type { Launch, MintState } from '../feed/market.js'

export type MomentumDecision = { action: 'wait' } | { action: 'buy'; reason: string } | { action: 'reject'; reason: string }

/** Everything the momentum rule looks at. Built from live state or from recorded launches. */
export interface MomentumSnapshot {
  ageMs: number
  /** Distinct buyers, the dev excluded. */
  buyers: number
  /** Organic buys (the create transaction's own buy excluded) minus sells, lamports. */
  netBuyLamports: bigint
  sellRatio: number
  mcapLamports: bigint
  devSold: boolean
  complete: boolean
}

export function momentumSnapshot(state: MintState, launch: Launch, now: number): MomentumSnapshot {
  const buyers = state.devStr && state.buyers.has(state.devStr) ? state.buyers.size - 1 : state.buyers.size
  const organicBuys = state.buyVolume - launch.devBuyLamports
  return {
    ageMs: now - launch.detectedAtWall,
    buyers,
    netBuyLamports: organicBuys - state.sellVolume,
    sellRatio: organicBuys > 0n ? Number(state.sellVolume) / Number(organicBuys) : 0,
    mcapLamports: marketCapLamports(state.curve),
    devSold: state.devSold,
    complete: state.complete,
  }
}

/**
 * Momentum entry: skip block-0 and buy only once real, distinct buyers show
 * up, the dev has not dumped, and price has not already run past the cap.
 * Trades off a slightly worse entry for far fewer instant rugs.
 */
export function decideMomentum(x: MomentumSnapshot, m: Config['momentum'], maxEntryMcapLamports: bigint): MomentumDecision {
  if (x.devSold) return { action: 'reject', reason: 'dev sold during momentum window' }
  if (x.complete) return { action: 'reject', reason: 'curve completed' }
  if (maxEntryMcapLamports > 0n && x.mcapLamports > maxEntryMcapLamports) {
    return { action: 'reject', reason: `mcap ${lamportsToSol(x.mcapLamports).toFixed(1)} SOL ran past max` }
  }
  if (x.ageMs > m.maxAgeMs) return { action: 'reject', reason: 'momentum window expired' }
  if (x.ageMs < m.minAgeMs) return { action: 'wait' }
  if (x.buyers < m.minBuyers) return { action: 'wait' }
  if (x.netBuyLamports < m.minNetBuyLamports) return { action: 'wait' }
  if (x.sellRatio > m.maxSellRatio) return { action: 'wait' }
  return {
    action: 'buy',
    reason: `${x.buyers} buyers, +${lamportsToSol(x.netBuyLamports).toFixed(2)} SOL net in ${(x.ageMs / 1000).toFixed(1)}s`,
  }
}
