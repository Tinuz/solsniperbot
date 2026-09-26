import type { Config } from '../config.js'
import { lamportsToSol } from '../config.js'
import { marketCapLamports } from '../pump/curve.js'
import type { Launch, MintState } from '../feed/market.js'

/** Buys by other wallets this soon after the launch was seen were bundled with it: insiders. */
export const EARLY_WINDOW_MS = 500

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
  /** Lamports other wallets bought within EARLY_WINDOW_MS of detection. */
  earlyBuyLamports: bigint
  /** Largest share of the supply held by one wallet other than the dev, %. */
  topBuyerPct: number
  /** Distinct buyers that are smart money (wallets whose early buys keep turning into runners). */
  smartBuyers: number
}

export function momentumSnapshot(state: MintState, launch: Launch, now: number, isSmart?: (wallet: string) => boolean): MomentumSnapshot {
  const buyers = state.devStr && state.buyers.has(state.devStr) ? state.buyers.size - 1 : state.buyers.size
  let smartBuyers = 0
  if (isSmart) for (const w of state.buyers) if (w !== state.devStr && isSmart(w)) smartBuyers++
  const organicBuys = state.buyVolume - launch.devBuyLamports
  let top = 0n
  for (const [wallet, tokens] of state.holders) if (wallet !== state.devStr && tokens > top) top = tokens
  const supply = state.curve.tokenTotalSupply
  return {
    ageMs: now - launch.detectedAtWall,
    buyers,
    netBuyLamports: organicBuys - state.sellVolume,
    sellRatio: organicBuys > 0n ? Number(state.sellVolume) / Number(organicBuys) : 0,
    mcapLamports: marketCapLamports(state.curve),
    devSold: state.devSold,
    complete: state.complete,
    earlyBuyLamports: state.earlyBuyVolume,
    topBuyerPct: supply > 0n ? Number((top * 1_000_000n) / supply) / 10_000 : 0,
    smartBuyers,
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
  // Insiders who bought alongside the launch, or one wallet holding a big bag, tend to dump into the first buyers.
  if (m.maxEarlyBuyLamports > 0n && x.earlyBuyLamports > m.maxEarlyBuyLamports) {
    return { action: 'reject', reason: `insiders bought ${lamportsToSol(x.earlyBuyLamports).toFixed(2)} SOL in the first ${EARLY_WINDOW_MS / 1000}s` }
  }
  if (m.maxTopBuyerPct > 0 && x.topBuyerPct > m.maxTopBuyerPct) {
    return { action: 'reject', reason: `one wallet holds ${x.topBuyerPct.toFixed(1)}% of the supply` }
  }
  if (x.ageMs > m.maxAgeMs) return { action: 'reject', reason: 'momentum window expired' }
  if (x.ageMs < m.minAgeMs) return { action: 'wait' }
  if (x.buyers < m.minBuyers) return { action: 'wait' }
  if (x.netBuyLamports < m.minNetBuyLamports) return { action: 'wait' }
  if (x.sellRatio > m.maxSellRatio) return { action: 'wait' }
  if (x.smartBuyers < m.minSmartBuyers) return { action: 'wait' }
  return {
    action: 'buy',
    reason: `${x.buyers} buyers${x.smartBuyers ? ` (${x.smartBuyers} smart)` : ''}, +${lamportsToSol(x.netBuyLamports).toFixed(2)} SOL net in ${(x.ageMs / 1000).toFixed(1)}s`,
  }
}
