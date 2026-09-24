import { PublicKey } from '@solana/web3.js'
import { ONE_BILLION_SUPPLY } from './constants.js'
import type { BondingCurve, FeeConfig, FeeTier, Fees, Global } from './layouts.js'

/**
 * Bonding curve state needed for quoting. All quote amounts are in lamports
 * (SOL-paired coins only), token amounts in base units (6 decimals).
 */
export interface CurveState {
  virtualTokenReserves: bigint
  virtualQuoteReserves: bigint
  realTokenReserves: bigint
  realQuoteReserves: bigint
  tokenTotalSupply: bigint
  complete: boolean
  creator: PublicKey
  isMayhemMode: boolean
  /** Per-coin creator fee override; 0 means the fee schedule applies. */
  creatorFeeBps: bigint
}

export interface FeeRates {
  protocolBps: bigint
  creatorBps: bigint
}

export interface FeeContext {
  global: Global | null
  feeConfig: FeeConfig | null
}

const BPS = 10_000n

export const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b
const min = (a: bigint, b: bigint) => (a < b ? a : b)
const fee = (amount: bigint, bps: bigint) => ceilDiv(amount * bps, BPS)

export function curveFromAccount(bc: BondingCurve): CurveState {
  return {
    virtualTokenReserves: bc.virtualTokenReserves,
    virtualQuoteReserves: bc.virtualQuoteReserves,
    realTokenReserves: bc.realTokenReserves,
    realQuoteReserves: bc.realQuoteReserves,
    tokenTotalSupply: bc.tokenTotalSupply,
    complete: bc.complete,
    creator: bc.creator,
    isMayhemMode: bc.isMayhemMode,
    creatorFeeBps: bc.creatorFeeBps,
  }
}

/** Market cap in lamports as the fee program computes it for tier selection. */
export function feeMarketCap(curve: CurveState): bigint {
  if (curve.virtualTokenReserves === 0n) return 0n
  const supply = curve.isMayhemMode ? curve.tokenTotalSupply : ONE_BILLION_SUPPLY
  return (curve.virtualQuoteReserves * supply) / curve.virtualTokenReserves
}

/** Fully diluted market cap in lamports at the current spot price. */
export function marketCapLamports(curve: CurveState): bigint {
  if (curve.virtualTokenReserves === 0n) return 0n
  return (curve.virtualQuoteReserves * curve.tokenTotalSupply) / curve.virtualTokenReserves
}

/** Mirrors `pump-fees-math::calculate_fee_tier`. */
export function calculateFeeTier(tiers: readonly FeeTier[], marketCap: bigint): Fees {
  const first = tiers[0]
  if (!first) throw new Error('fee tiers cannot be empty')
  if (marketCap < first.marketCapLamportsThreshold) return first.fees
  for (let i = tiers.length - 1; i >= 0; i--) {
    const tier = tiers[i]!
    if (marketCap >= tier.marketCapLamportsThreshold) return tier.fees
  }
  return first.fees
}

/**
 * Fee rates a SOL-paired curve trade pays at the curve's current market cap.
 * Mirrors the SDK's `computeFeesBps` + the "no creator, no creator fee" rule.
 */
export function feeRates(ctx: FeeContext, curve: CurveState): FeeRates {
  let protocolBps: bigint
  let creatorBps: bigint
  if (ctx.feeConfig && ctx.feeConfig.feeTiers.length > 0) {
    const tier = calculateFeeTier(ctx.feeConfig.feeTiers, feeMarketCap(curve))
    protocolBps = tier.protocolFeeBps
    creatorBps = tier.creatorFeeBps
  } else if (ctx.global) {
    protocolBps = ctx.global.feeBasisPoints
    creatorBps = ctx.global.creatorFeeBasisPoints
  } else {
    // No protocol state available: assume a conservative (high) rate.
    protocolBps = 95n
    creatorBps = 30n
  }
  if (ctx.global?.creatorFeeConfigurable && curve.creatorFeeBps > 0n) creatorBps = curve.creatorFeeBps
  if (curve.creator.equals(PublicKey.default)) creatorBps = 0n
  return { protocolBps, creatorBps }
}

export interface BuyQuote {
  tokensOut: bigint
  /** Quote that enters the curve (excludes fees). */
  netQuote: bigint
  fees: bigint
}

/**
 * Tokens received for spending exactly `spendable` lamports, fees included.
 * Implements the formula documented on `buy_exact_sol_in` in the pump IDL,
 * which `buy_exact_quote_in_v2` shares.
 */
export function quoteBuyExactIn(curve: CurveState, rates: FeeRates, spendable: bigint): BuyQuote {
  if (spendable <= 1n || curve.virtualTokenReserves === 0n || curve.complete) {
    return { tokensOut: 0n, netQuote: 0n, fees: 0n }
  }
  const totalBps = rates.protocolBps + rates.creatorBps
  let net = (spendable * BPS) / (BPS + totalBps)
  let fees = fee(net, rates.protocolBps) + fee(net, rates.creatorBps)
  if (net + fees > spendable) {
    net -= net + fees - spendable
    fees = fee(net, rates.protocolBps) + fee(net, rates.creatorBps)
  }
  if (net <= 1n) return { tokensOut: 0n, netQuote: 0n, fees: 0n }
  const tokens =
    ((net - 1n) * curve.virtualTokenReserves) / (curve.virtualQuoteReserves + net - 1n)
  return { tokensOut: min(tokens, curve.realTokenReserves), netQuote: net, fees }
}

/** Quote that enters the curve to buy exactly `tokens` (excludes fees). */
export function buyCostForTokens(curve: CurveState, tokens: bigint): bigint {
  const amount = min(tokens, curve.realTokenReserves)
  if (amount <= 0n) return 0n
  return (amount * curve.virtualQuoteReserves) / (curve.virtualTokenReserves - amount) + 1n
}

/** Total lamports (fees included) to buy exactly `tokens`, as `buy_v2` charges. */
export function quoteBuyExactTokens(curve: CurveState, rates: FeeRates, tokens: bigint): bigint {
  const cost = buyCostForTokens(curve, tokens)
  return cost + fee(cost, rates.protocolBps) + fee(cost, rates.creatorBps)
}

export interface SellQuote {
  /** Lamports the seller receives after fees. */
  quoteOut: bigint
  /** Lamports leaving the curve before fees. */
  grossQuote: bigint
  fees: bigint
}

export function quoteSell(curve: CurveState, rates: FeeRates, tokens: bigint): SellQuote {
  if (tokens <= 0n || curve.virtualTokenReserves === 0n) return { quoteOut: 0n, grossQuote: 0n, fees: 0n }
  const gross = (tokens * curve.virtualQuoteReserves) / (curve.virtualTokenReserves + tokens)
  const fees = fee(gross, rates.protocolBps) + fee(gross, rates.creatorBps)
  return { quoteOut: gross > fees ? gross - fees : 0n, grossQuote: gross, fees }
}

/** Curve state after a buy of `tokens` that moved `netQuote` into the curve. */
export function applyBuy(curve: CurveState, tokens: bigint, netQuote: bigint): CurveState {
  return {
    ...curve,
    virtualTokenReserves: curve.virtualTokenReserves - tokens,
    virtualQuoteReserves: curve.virtualQuoteReserves + netQuote,
    realTokenReserves: curve.realTokenReserves - tokens,
    realQuoteReserves: curve.realQuoteReserves + netQuote,
  }
}

/** Curve state after a sell of `tokens` that took `grossQuote` out of the curve. */
export function applySell(curve: CurveState, tokens: bigint, grossQuote: bigint): CurveState {
  return {
    ...curve,
    virtualTokenReserves: curve.virtualTokenReserves + tokens,
    virtualQuoteReserves: curve.virtualQuoteReserves - grossQuote,
    realTokenReserves: curve.realTokenReserves + tokens,
    realQuoteReserves: curve.realQuoteReserves - grossQuote,
  }
}

/** Applies a buy for `spendable` lamports and returns the fill and the new state. */
export function simulateBuy(
  curve: CurveState,
  rates: FeeRates,
  spendable: bigint,
): { quote: BuyQuote; after: CurveState } {
  const quote = quoteBuyExactIn(curve, rates, spendable)
  const intoCurve = buyCostForTokens(curve, quote.tokensOut)
  return { quote, after: applyBuy(curve, quote.tokensOut, intoCurve) }
}

/** Spot price in lamports per whole token (10^6 base units). */
export function spotPriceLamports(curve: CurveState): number {
  if (curve.virtualTokenReserves === 0n) return 0
  return (Number(curve.virtualQuoteReserves) / Number(curve.virtualTokenReserves)) * 1e6
}

/** Share of sellable supply already bought, in basis points. */
export function curveProgressBps(curve: CurveState, initialRealTokenReserves: bigint): number {
  if (initialRealTokenReserves <= 0n) return 0
  const sold = initialRealTokenReserves - curve.realTokenReserves
  return Number((sold * BPS) / initialRealTokenReserves)
}

export function applyBps(amount: bigint, bps: number): bigint {
  return (amount * BigInt(Math.round(bps))) / BPS
}

/** `amount` reduced by `slippageBps`, floored at zero. */
export function withSlippageDown(amount: bigint, slippageBps: number): bigint {
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.round(slippageBps))))
  return (amount * (BPS - bps)) / BPS
}

/** `amount` increased by `slippageBps`. */
export function withSlippageUp(amount: bigint, slippageBps: number): bigint {
  const bps = BigInt(Math.max(0, Math.round(slippageBps)))
  return (amount * (BPS + bps)) / BPS
}
