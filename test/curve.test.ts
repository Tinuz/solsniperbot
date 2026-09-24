import { Keypair, PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import {
  type CurveState,
  applyBuy,
  buyCostForTokens,
  curveProgressBps,
  feeRates,
  quoteBuyExactIn,
  quoteBuyExactTokens,
  quoteSell,
  simulateBuy,
  withSlippageDown,
  withSlippageUp,
} from '../src/pump/curve.js'
import type { FeeConfig, Global } from '../src/pump/layouts.js'
import { big, bn, randomBig, rng, sdk } from './helpers.js'

const INITIAL_REAL = 793_100_000_000_000n

const fees = (p: bigint, c: bigint) => ({ lpFeeBps: 0n, protocolFeeBps: p, creatorFeeBps: c })
const feeConfig: FeeConfig = {
  admin: PublicKey.default,
  flatFees: fees(95n, 30n),
  feeTiers: [
    { marketCapLamportsThreshold: 0n, fees: fees(95n, 30n) },
    { marketCapLamportsThreshold: 100_000_000_000n, fees: fees(93n, 50n) },
    { marketCapLamportsThreshold: 300_000_000_000n, fees: fees(90n, 25n) },
  ],
  stableFeeTiers: [],
  exoticFlatFees: fees(0n, 0n),
}

const global = {
  feeBasisPoints: 95n,
  creatorFeeBasisPoints: 5n,
  creatorFeeConfigurable: false,
  tokenTotalSupply: 1_000_000_000_000_000n,
  initialRealTokenReserves: INITIAL_REAL,
} as Global

const toSdkFees = (f: ReturnType<typeof fees>) => ({ lpFeeBps: bn(f.lpFeeBps), protocolFeeBps: bn(f.protocolFeeBps), creatorFeeBps: bn(f.creatorFeeBps) })
const sdkFeeConfig = {
  admin: PublicKey.default,
  flatFees: toSdkFees(feeConfig.flatFees),
  feeTiers: feeConfig.feeTiers.map((t) => ({ marketCapLamportsThreshold: bn(t.marketCapLamportsThreshold), fees: toSdkFees(t.fees) })),
  stableFeeTiers: [],
  exoticFlatFees: toSdkFees(feeConfig.exoticFlatFees),
}
const sdkGlobal = {
  feeBasisPoints: bn(95n),
  creatorFeeBasisPoints: bn(5n),
  creatorFeeConfigurable: false,
  tokenTotalSupply: bn(global.tokenTotalSupply),
}

function randomCurve(next: () => number): CurveState {
  // Walk a fresh curve forward by a random amount of buying.
  const bought = randomBig(next, 0n, 700_000_000_000_000n)
  const vt = 1_073_000_000_000_000n
  const vq = 30_000_000_000n
  const cost = (bought * vq) / (vt - bought) + 1n
  return {
    virtualTokenReserves: vt - bought,
    virtualQuoteReserves: vq + cost,
    realTokenReserves: INITIAL_REAL - bought,
    realQuoteReserves: cost,
    tokenTotalSupply: 1_000_000_000_000_000n,
    complete: false,
    creator: next() < 0.1 ? PublicKey.default : Keypair.generate().publicKey,
    isMayhemMode: false,
    creatorFeeBps: 0n,
  }
}

const toSdkCurve = (c: CurveState) => ({
  virtualTokenReserves: bn(c.virtualTokenReserves),
  virtualQuoteReserves: bn(c.virtualQuoteReserves),
  realTokenReserves: bn(c.realTokenReserves),
  realQuoteReserves: bn(c.realQuoteReserves),
  tokenTotalSupply: bn(c.tokenTotalSupply),
  complete: c.complete,
  creator: c.creator,
  isMayhemMode: c.isMayhemMode,
  isCashbackCoin: false,
  quoteMint: PublicKey.default,
  creatorFeeBps: bn(c.creatorFeeBps),
  canEditCreatorFee: false,
  isHolderReward: false,
})

const ctx = { global, feeConfig }
const sdkCommon = { global: sdkGlobal, feeConfig: sdkFeeConfig, mintSupply: bn(1_000_000_000_000_000n), quoteMint: PublicKey.default }

describe('fee rates', () => {
  it('select the same market-cap tier as the SDK', () => {
    const next = rng(7)
    for (let i = 0; i < 300; i++) {
      const curve = randomCurve(next)
      const mine = feeRates(ctx, curve)
      const ref = sdk.computeFeesBps({
        global: sdkGlobal,
        feeConfig: sdkFeeConfig,
        mintSupply: bn(1_000_000_000_000_000n),
        virtualQuoteReserves: bn(curve.virtualQuoteReserves),
        virtualTokenReserves: bn(curve.virtualTokenReserves),
        quoteMint: PublicKey.default,
        creatorFeeBps: bn(0),
      })
      expect(mine.protocolBps).toBe(big(ref.protocolFeeBps))
      const creatorExpected = curve.creator.equals(PublicKey.default) ? 0n : big(ref.creatorFeeBps)
      expect(mine.creatorBps).toBe(creatorExpected)
    }
  })

  it('fall back to Global rates without a FeeConfig', () => {
    const curve = randomCurve(rng(1))
    curve.creator = Keypair.generate().publicKey
    expect(feeRates({ global, feeConfig: null }, curve)).toEqual({ protocolBps: 95n, creatorBps: 5n })
  })
})

describe('quotes agree with the official SDK', () => {
  it('exact-tokens buy cost is identical', () => {
    const next = rng(11)
    for (let i = 0; i < 300; i++) {
      const curve = randomCurve(next)
      const tokens = randomBig(next, 1n, curve.realTokenReserves / 4n)
      const mine = quoteBuyExactTokens(curve, feeRates(ctx, curve), tokens)
      const ref = sdk.getBuySolAmountFromTokenAmount({ ...sdkCommon, bondingCurve: toSdkCurve(curve), amount: bn(tokens) })
      expect(mine).toBe(big(ref))
    }
  })

  it('sell proceeds are identical', () => {
    const next = rng(13)
    for (let i = 0; i < 300; i++) {
      const curve = randomCurve(next)
      const tokens = randomBig(next, 1n, 100_000_000_000_000n)
      const mine = quoteSell(curve, feeRates(ctx, curve), tokens).quoteOut
      const ref = sdk.getSellSolAmountFromTokenAmount({ ...sdkCommon, bondingCurve: toSdkCurve(curve), amount: bn(tokens) })
      expect(mine).toBe(big(ref))
    }
  })

  it('exact-in buy output is within one lamport of rounding of the SDK estimate', () => {
    const next = rng(17)
    for (let i = 0; i < 300; i++) {
      const curve = randomCurve(next)
      const spend = randomBig(next, 1_000_000n, 5_000_000_000n)
      const mine = quoteBuyExactIn(curve, feeRates(ctx, curve), spend).tokensOut
      const ref = big(sdk.getBuyTokenAmountFromSolAmount({ ...sdkCommon, bondingCurve: toSdkCurve(curve), amount: bn(spend) }))
      // The IDL formula subtracts its lamport after the fee split, the SDK before;
      // one lamport is worth (vt / vq) base units.
      const oneLamport = curve.virtualTokenReserves / curve.virtualQuoteReserves + 1n
      const diff = mine > ref ? mine - ref : ref - mine
      expect(diff <= 2n * oneLamport).toBe(true)
    }
  })
})

describe('exact-in buy invariants', () => {
  it('never charges more than the budget and matches the documented formula', () => {
    const next = rng(19)
    for (let i = 0; i < 500; i++) {
      const curve = randomCurve(next)
      const rates = feeRates(ctx, curve)
      const spend = randomBig(next, 2n, 10_000_000_000n)
      const q = quoteBuyExactIn(curve, rates, spend)
      expect(q.netQuote + q.fees <= spend).toBe(true)
      // Paying for the returned tokens must fit in the spend (program re-derives cost).
      if (q.tokensOut > 0n) expect(buyCostForTokens(curve, q.tokensOut) <= q.netQuote).toBe(true)
    }
  })

  it('a fresh curve gives the well-known ~34.6M tokens for 1 SOL at 1.25% fees', () => {
    const fresh: CurveState = {
      virtualTokenReserves: 1_073_000_000_000_000n,
      virtualQuoteReserves: 30_000_000_000n,
      realTokenReserves: INITIAL_REAL,
      realQuoteReserves: 0n,
      tokenTotalSupply: 1_000_000_000_000_000n,
      complete: false,
      creator: Keypair.generate().publicKey,
      isMayhemMode: false,
      creatorFeeBps: 0n,
    }
    const { quote, after } = simulateBuy(fresh, { protocolBps: 95n, creatorBps: 30n }, 1_000_000_000n)
    expect(Number(quote.tokensOut) / 1e6).toBeGreaterThan(34_000_000)
    expect(Number(quote.tokensOut) / 1e6).toBeLessThan(35_000_000)
    expect(after.realTokenReserves).toBe(INITIAL_REAL - quote.tokensOut)
    expect(curveProgressBps(after, INITIAL_REAL)).toBeGreaterThan(400)
  })

  it('returns nothing for a completed curve', () => {
    const curve = { ...randomCurve(rng(3)), complete: true }
    expect(quoteBuyExactIn(curve, { protocolBps: 95n, creatorBps: 30n }, 1_000_000_000n).tokensOut).toBe(0n)
  })

  it('applyBuy then sell of the same tokens loses only fees and rounding', () => {
    const curve = randomCurve(rng(5))
    const rates = { protocolBps: 95n, creatorBps: 30n }
    const spend = 500_000_000n
    const q = quoteBuyExactIn(curve, rates, spend)
    const after = applyBuy(curve, q.tokensOut, buyCostForTokens(curve, q.tokensOut))
    const back = quoteSell(after, rates, q.tokensOut).quoteOut
    expect(back < spend).toBe(true)
    expect(Number(back) / Number(spend)).toBeGreaterThan(0.97)
  })
})

describe('slippage helpers', () => {
  it('scale in basis points and clamp', () => {
    expect(withSlippageDown(10_000n, 2_500)).toBe(7_500n)
    expect(withSlippageDown(10_000n, 20_000)).toBe(0n)
    expect(withSlippageUp(10_000n, 2_500)).toBe(12_500n)
  })
})
