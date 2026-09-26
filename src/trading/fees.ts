import type { Config } from '../config.js'

/** Signature fee of a transaction with one signer. */
export const BASE_FEE_LAMPORTS = 5_000n

/**
 * `floor`: what a transaction pays in `fixed` mode, and at least in `dynamic`
 * mode. `worst`: the most it can pay; dynamic priority fees go up to
 * PRIORITY_FEE_MAX_SOL when the network is busy. Estimates made without a live
 * fee sample (replay, research, the edge gate) use `worst`, so a strategy is
 * never judged on fees cheaper than it may really pay.
 */
export type FeeBasis = 'floor' | 'worst'

export function priorityLamports(cfg: Config, side: 'buy' | 'sell', basis: FeeBasis = 'floor'): bigint {
  if (basis === 'worst' && cfg.priorityFeeMode === 'dynamic') return cfg.maxPriorityLamports
  return side === 'buy' ? cfg.buyPriorityLamports : cfg.sellPriorityLamports
}

/** Network cost of one trade transaction: signature fee, priority fee and tip. */
export function txNetworkLamports(cfg: Config, side: 'buy' | 'sell', basis: FeeBasis = 'floor'): bigint {
  const tip = side === 'buy' ? cfg.buyTipLamports : cfg.sellTipLamports
  return BASE_FEE_LAMPORTS + priorityLamports(cfg, side, basis) + tip
}

/** Priority fee a transaction pays for `computeUnits` at `microLamportsPerCu` (rounded up, as the runtime does). */
export function priorityFeeFor(computeUnits: number, microLamportsPerCu: bigint): bigint {
  return (BigInt(computeUnits) * microLamportsPerCu + 999_999n) / 1_000_000n
}
