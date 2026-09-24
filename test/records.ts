import { Keypair } from '@solana/web3.js'
import type { LaunchRecord, TradeRow } from '../src/learning/record.js'
import { summarize } from '../src/learning/record.js'
import { type CurveState, applyBuy, applySell, buyCostForTokens, quoteBuyExactIn, quoteSell } from '../src/pump/curve.js'

const RATES = { protocolBps: 95n, creatorBps: 30n }
const key = () => Keypair.generate().publicKey.toBase58()

export type Step = { dt: number; buy?: number; sellTokens?: number; wallet?: number }

/** A recorded launch whose trade rows follow exact bonding-curve math. */
export function buildRecord(steps: Step[], over: Partial<LaunchRecord> = {}): LaunchRecord {
  let curve: CurveState = {
    virtualTokenReserves: 1_073_000_000_000_000n,
    virtualQuoteReserves: 30_000_000_000n,
    realTokenReserves: 793_100_000_000_000n,
    realQuoteReserves: 0n,
    tokenTotalSupply: 1_000_000_000_000_000n,
    complete: false,
    creator: Keypair.generate().publicKey,
    isMayhemMode: false,
    creatorFeeBps: 0n,
  }
  const dev = quoteBuyExactIn(curve, RATES, 500_000_000n)
  curve = applyBuy(curve, dev.tokensOut, buyCostForTokens(curve, dev.tokensOut))
  const start = curve
  const trades: TradeRow[] = []
  for (const s of steps) {
    if (s.buy !== undefined) {
      const q = quoteBuyExactIn(curve, RATES, BigInt(Math.round(s.buy)))
      const cost = buyCostForTokens(curve, q.tokensOut)
      curve = applyBuy(curve, q.tokensOut, cost)
      trades.push([s.dt, Number(curve.virtualQuoteReserves), Number(curve.virtualTokenReserves), 1, Number(cost), s.wallet ?? trades.length + 1])
    } else {
      const amount = BigInt(Math.round(s.sellTokens!))
      const q = quoteSell(curve, RATES, amount)
      curve = applySell(curve, amount, q.grossQuote)
      trades.push([s.dt, Number(curve.virtualQuoteReserves), Number(curve.virtualTokenReserves), -1, Number(q.grossQuote), s.wallet ?? trades.length + 1])
    }
  }
  const base = {
    v: 1 as const, mint: key(), name: 'Coin', symbol: 'COIN', uri: 'https://x', dev: key(), creator: key(), tokenProgram: key(),
    mayhem: false, holderReward: false, source: 'ws' as const, executed: true, slot: 1, t: 1_000,
    curve: { vq: Number(start.virtualQuoteReserves), vt: Number(start.virtualTokenReserves), rt: Number(start.realTokenReserves), supply: 1e15 },
    tokenOffset: 279_900_000_000_000, initialRt: 793_100_000_000_000,
    devBuyLamports: 500_000_000, devBuyTokens: Number(dev.tokensOut), creatorLaunches: 1,
    feeBps: { protocol: 95, creator: 30 }, verdict: 'buying' as const, reason: '', trades,
    truncated: false, graduated: false, partial: false, horizonMs: 900_000,
  }
  return { ...base, summary: summarize(base), ...over }
}

/** Price pumps ~+80% in 20s, then buyers leave and it fades below entry. */
export function pumpThenFade(t: number): LaunchRecord {
  const steps: Step[] = []
  for (let i = 1; i <= 8; i++) steps.push({ dt: i * 2_500, buy: 1.6e9 })
  for (let i = 1; i <= 10; i++) steps.push({ dt: 20_000 + i * 4_000, sellTokens: 20e12 })
  return buildRecord(steps, { t })
}

/** Small buys, then steady selling and a dev dump. */
export function slowRug(t: number): LaunchRecord {
  const steps: Step[] = [{ dt: 1_000, buy: 0.3e9 }, { dt: 3_000, buy: 0.2e9 }]
  for (let i = 1; i <= 6; i++) steps.push({ dt: 5_000 + i * 5_000, sellTokens: 3e12 })
  steps.push({ dt: 40_000, sellTokens: 15e12, wallet: 0 })
  return buildRecord(steps, { t })
}

/** Deterministic mix of archetypes, one launch every `spacingMs`. */
export function dataset(n: number, opts: { spacingMs?: number; start?: number; pumpShare?: number; seed?: number } = {}): LaunchRecord[] {
  let s = opts.seed ?? 7
  const rand = () => ((s = (s * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31)
  const spacing = opts.spacingMs ?? 5 * 60_000
  const start = opts.start ?? 1_750_000_000_000
  return Array.from({ length: n }, (_, i) => (rand() < (opts.pumpShare ?? 0.6) ? pumpThenFade : slowRug)(start + i * spacing))
}

/** Like pumpThenFade but peaks around +65%: selling everything at +75% never triggers. */
export function smallPump(t: number): LaunchRecord {
  const steps: Step[] = []
  for (let i = 1; i <= 6; i++) steps.push({ dt: i * 2_500, buy: 1.6e9 })
  for (let i = 1; i <= 10; i++) steps.push({ dt: 20_000 + i * 4_000, sellTokens: 20e12 })
  return buildRecord(steps, { t })
}

/** Nobody trades after the launch. */
export const deadCoin = (t: number): LaunchRecord => buildRecord([], { t })

/** One small buy, then the dev dumps within two seconds. */
export const earlyRug = (t: number): LaunchRecord =>
  buildRecord([{ dt: 800, buy: 0.3e9 }, { dt: 1_500, sellTokens: 15e12, wallet: 0 }], { t })

/** Steady buying for 30s, then a slow fade. */
export function steadyPump(t: number): LaunchRecord {
  const steps: Step[] = []
  for (let i = 1; i <= 20; i++) steps.push({ dt: i * 1_500, buy: 0.8e9 })
  for (let i = 1; i <= 12; i++) steps.push({ dt: 30_000 + i * 5_000, sellTokens: 15e12 })
  return buildRecord(steps, { t })
}

/** A market where blind instant buys pay for dead coins and early rugs, and waiting for momentum pays off. */
export function momentumMarket(n: number, start = 1_750_000_000_000): LaunchRecord[] {
  let s = 5
  const rand = () => ((s = (s * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31)
  return Array.from({ length: n }, (_, i) => {
    const r = rand()
    const t = start + i * 300_000
    return r < 0.55 ? deadCoin(t) : r < 0.85 ? earlyRug(t) : steadyPump(t)
  })
}
