import { Keypair } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import type { LaunchRecord, TradeRow } from '../src/learning/record.js'
import { summarize } from '../src/learning/record.js'
import { type ReplayConfig, replayConfigFrom, replayLaunch, summarizeResults } from '../src/learning/replay.js'
import {
  type CurveState,
  applyBuy,
  applySell,
  buyCostForTokens,
  quoteBuyExactIn,
  quoteSell,
} from '../src/pump/curve.js'

const RATES = { protocolBps: 95n, creatorBps: 30n }
const OFFSET = 279_900_000_000_000n
const key = () => Keypair.generate().publicKey.toBase58()

type Step = { dt: number; buy?: number; sellTokens?: number; wallet?: number }

/** Builds a record whose trade rows follow exact curve math. */
function record(steps: Step[], over: Partial<LaunchRecord> = {}): LaunchRecord {
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
  // Dev buys 0.5 SOL in the create transaction.
  const dev = quoteBuyExactIn(curve, RATES, 500_000_000n)
  curve = applyBuy(curve, dev.tokensOut, buyCostForTokens(curve, dev.tokensOut))
  const start = curve
  const trades: TradeRow[] = []
  for (const s of steps) {
    if (s.buy !== undefined) {
      const q = quoteBuyExactIn(curve, RATES, BigInt(s.buy))
      const cost = buyCostForTokens(curve, q.tokensOut)
      curve = applyBuy(curve, q.tokensOut, cost)
      trades.push([s.dt, Number(curve.virtualQuoteReserves), Number(curve.virtualTokenReserves), 1, Number(cost), s.wallet ?? trades.length + 1])
    } else {
      const q = quoteSell(curve, RATES, BigInt(s.sellTokens!))
      curve = applySell(curve, BigInt(s.sellTokens!), q.grossQuote)
      trades.push([s.dt, Number(curve.virtualQuoteReserves), Number(curve.virtualTokenReserves), -1, Number(q.grossQuote), s.wallet ?? trades.length + 1])
    }
  }
  const base = {
    v: 1 as const, mint: key(), name: 'x', symbol: 'X', uri: 'u', dev: key(), creator: key(), tokenProgram: key(),
    mayhem: false, holderReward: false, source: 'ws' as const, executed: true, slot: 1, t: 1_000,
    curve: { vq: Number(start.virtualQuoteReserves), vt: Number(start.virtualTokenReserves), rt: Number(start.realTokenReserves), supply: 1e15 },
    tokenOffset: Number(OFFSET), initialRt: 793_100_000_000_000,
    devBuyLamports: 500_000_000, devBuyTokens: Number(dev.tokensOut), creatorLaunches: 1,
    feeBps: { protocol: 95, creator: 30 }, verdict: 'buying' as const, reason: '', trades,
    truncated: false, graduated: false, partial: false, horizonMs: 900_000,
  }
  return { ...base, summary: summarize(base), ...over }
}

const cfg = loadConfig({
  RPC_URL: 'https://rpc.example.com',
  TAKE_PROFIT: '50:100',
  STOP_LOSS_PCT: '30',
  TRAILING_STOP_PCT: '0',
  MAX_HOLD_SECONDS: '600',
  STALE_SECONDS: '30',
  PAPER_LATENCY_MS: '300',
  BUY_SOL: '0.1',
})
const rc = (over: Partial<ReplayConfig> = {}) => replayConfigFrom(cfg, { entry: 'instant', ...over })

describe('replay', () => {
  it('matches the live exact math for a quiet round trip', () => {
    const r = replayLaunch(record([]), rc())
    expect(r.entered).toBe(true)
    expect(r.exits).toEqual(['no trading activity'])
    // Same trade with the bot's bigint curve math: buy, then sell into the curve it moved.
    const start = record([]).curve
    const curve: CurveState = {
      virtualTokenReserves: BigInt(start.vt), virtualQuoteReserves: BigInt(start.vq), realTokenReserves: BigInt(start.rt),
      realQuoteReserves: 0n, tokenTotalSupply: 1_000_000_000_000_000n, complete: false,
      creator: Keypair.generate().publicKey, isMayhemMode: false, creatorFeeBps: 0n,
    }
    const q = quoteBuyExactIn(curve, RATES, 100_000_000n)
    const after = applyBuy(curve, q.tokensOut, buyCostForTokens(curve, q.tokensOut))
    const proceeds = quoteSell(after, RATES, q.tokensOut).quoteOut
    expect(Math.abs(r.proceedsLamports - Number(proceeds))).toBeLessThanOrEqual(2)
    expect(r.networkLamports).toBe(Number(cfg.buyTipLamports + cfg.buyPriorityLamports + cfg.sellTipLamports + cfg.sellPriorityLamports) + 10_000)
    // Stale fires 30s after the last trade (t=0) and fills 300ms later; entry filled at 300ms.
    expect(r.holdMs).toBe(30_000)
  })

  it('takes profit when buyers push the price up', () => {
    const r = replayLaunch(record([{ dt: 1_000, buy: 3e9 }, { dt: 2_000, buy: 4e9 }, { dt: 3_000, buy: 5e9 }]), rc())
    expect(r.exits[0]).toMatch(/take profit/)
    expect(r.pnlLamports).toBeGreaterThan(0)
    expect(r.peakGainPct).toBeGreaterThan(50)
  })

  it('walks the take-profit tiers', () => {
    const steps: Step[] = [
      { dt: 1_000, buy: 3e9 }, { dt: 2_000, buy: 3e9 },
      { dt: 5_000, buy: 6e9 }, { dt: 6_000, buy: 8e9 },
    ]
    const r = replayLaunch(record(steps), rc({ exits: { ...cfg.exits, takeProfit: [{ gainPct: 40, sellPct: 50 }, { gainPct: 150, sellPct: 100 }] } }))
    expect(r.exits).toHaveLength(2)
    expect(r.exits[0]).toMatch(/tier 1/)
    expect(r.exits[1]).toMatch(/tier 2/)
  })

  it('exits when the dev sells', () => {
    const r = replayLaunch(record([{ dt: 2_000, sellTokens: 10_000_000_000_000, wallet: 0 }]), rc())
    expect(r.exits).toEqual(['dev sold'])
    expect(r.pnlLamports).toBeLessThan(0)
  })

  it('skips the entry when the curve runs away during latency', () => {
    const r = replayLaunch(record([{ dt: 100, buy: 20e9 }]), rc({ buySlippageBps: 1_000 }))
    expect(r).toMatchObject({ entered: false, skipReason: 'slippage' })
  })

  it('uses the live momentum rule to time entries', () => {
    const buyers = Array.from({ length: 4 }, (_, i) => ({ dt: 500 + i * 300, buy: 800_000_000, wallet: i + 1 }))
    const mcfg = { ...cfg.momentum, minAgeMs: 1_000, maxAgeMs: 10_000, minBuyers: 4, minNetBuyLamports: 2_000_000_000n }
    const r = replayLaunch(record(buyers), rc({ entry: 'momentum', momentum: mcfg }))
    expect(r.entered).toBe(true)
    expect(r.entryMs).toBe(1_500 + 300) // 4th buyer at 1400ms, next 250ms check at 1500ms, plus latency
    expect(replayLaunch(record([]), rc({ entry: 'momentum', momentum: mcfg }))).toMatchObject({ entered: false, skipReason: 'momentum window expired' })
  })

  it('summarizes results in time order with drawdown', () => {
    const mk = (pnl: number) => ({ entered: true, pnlLamports: pnl, pnlPct: pnl / 1e6, holdMs: 1_000, costLamports: 1, proceedsLamports: 0, networkLamports: 0, exits: [], peakGainPct: 0 })
    const s = summarizeResults([mk(100), mk(-300), mk(50), mk(-100), mk(400)])
    expect(s).toMatchObject({ trades: 5, wins: 3, totalPnlLamports: 150, maxDrawdownLamports: 350 })
  })
})

describe('replay: insider signals', () => {
  const base = { ENTRY_MODE: 'momentum', MOMENTUM_MIN_AGE_MS: '1000', MOMENTUM_MIN_BUYERS: '3', MOMENTUM_MIN_NET_BUY_SOL: '1' }
  const cfgOf = (env: Record<string, string>) => replayConfigFrom(loadConfig({ RPC_URL: 'https://rpc.example.com', ...base, ...env }))
  const organic: Step[] = [
    { dt: 1_200, buy: 0.6e9 },
    { dt: 1_400, buy: 0.6e9 },
    { dt: 1_600, buy: 0.6e9 },
  ]

  it('sees buys bundled with the launch like the live engine', () => {
    const rec = record([{ dt: 200, buy: 2e9, wallet: 9 }, ...organic])
    expect(replayLaunch(rec, cfgOf({})).entered).toBe(true)
    const r = replayLaunch(rec, cfgOf({ MOMENTUM_MAX_EARLY_BUY_SOL: '1' }))
    expect(r.entered).toBe(false)
    expect(r.skipReason).toMatch(/insiders bought 1\.9\d SOL in the first 0.5s/) // 2 SOL spent, ~1.98 into the curve after fees
    // Later buys by the same amount are not "early".
    expect(replayLaunch(record([{ dt: 900, buy: 2e9, wallet: 9 }, ...organic]), cfgOf({ MOMENTUM_MAX_EARLY_BUY_SOL: '1' })).entered).toBe(true)
  })

  it('tracks the biggest holder from the reserves, and lets a sold bag go', () => {
    // One wallet buys ~8% of the supply.
    const whale = record([{ dt: 800, buy: 3e9, wallet: 9 }, ...organic])
    expect(replayLaunch(whale, cfgOf({ MOMENTUM_MAX_TOP_BUYER_PCT: '5' })).skipReason).toMatch(/one wallet holds [0-9.]+% of the supply/)
    expect(replayLaunch(whale, cfgOf({ MOMENTUM_MAX_TOP_BUYER_PCT: '12' })).entered).toBe(true)
    // It sells most of it before the bot decides: no longer a big holder.
    const sold = record([{ dt: 800, buy: 3e9, wallet: 9 }, { dt: 900, sellTokens: 60e12, wallet: 9 }, ...organic, { dt: 1_700, buy: 0.6e9 }])
    expect(replayLaunch(sold, cfgOf({ MOMENTUM_MAX_TOP_BUYER_PCT: '5' })).skipReason ?? '').not.toMatch(/one wallet/)
  })
})
