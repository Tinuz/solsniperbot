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

/**
 * Upfront account costs of a first buy: Token-2022 ATA rent plus pump's
 * one-time user volume accumulator, rounded up. The ATA rent comes back when
 * the account is closed, but it must be on hand to buy.
 */
export const BUY_ACCOUNT_OVERHEAD_LAMPORTS = 4_500_000n

/**
 * Network costs per trade, at the most they can be (dynamic priority fees at
 * their cap): the exit reserve and the viability checks must hold in a busy
 * network too.
 */
export function feeSchedule(cfg: Config) {
  const buyNetwork = txNetworkLamports(cfg, 'buy', 'worst')
  const sellNetwork = txNetworkLamports(cfg, 'sell', 'worst')
  return {
    buyNetwork,
    sellNetwork,
    buyUpfront: buyNetwork + BUY_ACCOUNT_OVERHEAD_LAMPORTS,
    roundTrip: buyNetwork + sellNetwork,
  }
}

/**
 * A trade only makes sense if tips and priority fees are a small share of it:
 * at 0.003 SOL round-trip, a 0.01 SOL trade starts 30% down. The smallest
 * trade whose round-trip fees (at their worst) stay under MAX_FEE_DRAG_PCT,
 * and at least MIN_BUY_SOL.
 */
export function minViableBuyLamports(cfg: Config): bigint {
  const { roundTrip } = feeSchedule(cfg)
  const dragBps = BigInt(Math.round(cfg.survival.maxFeeDragPct * 100))
  const byFees = (roundTrip * 10_000n + dragBps - 1n) / dragBps
  return byFees > cfg.survival.minBuyLamports ? byFees : cfg.survival.minBuyLamports
}
