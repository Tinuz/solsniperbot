import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Keypair } from '@solana/web3.js'
import { pino } from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import type { LaunchRecord, TradeRow } from '../src/learning/record.js'
import { summarize } from '../src/learning/record.js'
import { LaunchRecorder } from '../src/learning/recorder.js'
import type { TradeEvent } from '../src/pump/events.js'
import { type ReplayConfig, replayConfigFrom, replayLaunch, summarizeResults } from '../src/learning/replay.js'
import { paramsFromConfig } from '../src/learning/tunable.js'
import { Evaluator } from '../src/learning/tuner.js'
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
    expect(r.entryMs).toBe(1_400 + 300) // decided on the 4th buyer's trade at 1400ms, like the live engine, plus latency
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
    // One wallet buys ~9% of the supply: seen on that very trade, as live.
    const whale = record([{ dt: 800, buy: 3e9, wallet: 9 }, ...organic])
    expect(replayLaunch(whale, cfgOf({ MOMENTUM_MAX_TOP_BUYER_PCT: '5' })).skipReason).toMatch(/one wallet holds [0-9.]+% of the supply/)
    expect(replayLaunch(whale, cfgOf({ MOMENTUM_MAX_TOP_BUYER_PCT: '12' })).entered).toBe(true)
    // It buys more: past 10% of the supply...
    const more = record([{ dt: 800, buy: 3e9, wallet: 9 }, { dt: 1_000, buy: 1e9, wallet: 9 }, ...organic])
    expect(replayLaunch(more, cfgOf({ MOMENTUM_MAX_TOP_BUYER_PCT: '10' })).skipReason).toMatch(/one wallet holds 1\d\.\d% of the supply/)
    // ...unless it sold most of its bag first: what it sold no longer counts.
    const sold = record([{ dt: 800, buy: 3e9, wallet: 9 }, { dt: 900, sellTokens: 60e12, wallet: 9 }, { dt: 1_000, buy: 1e9, wallet: 9 }, ...organic])
    const r = replayLaunch(sold, cfgOf({ MOMENTUM_MAX_TOP_BUYER_PCT: '10' }))
    expect(r.skipReason ?? '').not.toMatch(/one wallet/)
    expect(r.entered).toBe(true)
  })
})

describe('replay: moonbag', () => {
  const env = {
    RPC_URL: 'https://rpc.example.com', TAKE_PROFIT: '60:50,150:100', STOP_LOSS_PCT: '30', TRAILING_STOP_PCT: '20', TRAILING_ARM_PCT: '30',
    MAX_HOLD_SECONDS: '180', STALE_SECONDS: '30', PAPER_LATENCY_MS: '300', BUY_SOL: '0.1',
  }
  const off = loadConfig(env)
  const on = loadConfig({ ...env, MOONBAG_PCT: '25' })
  const run = (rec: LaunchRecord, c = on) => replayLaunch(rec, replayConfigFrom(c, { entry: 'instant' }))
  // Buyers push it past 8x over 90s, then it bleeds back.
  const runner = (t = 1_000) => {
    const steps: Step[] = []
    for (let i = 0; i < 30; i++) steps.push({ dt: 1_000 + i * 3_000, buy: 2e9 })
    for (let i = 0; i < 12; i++) steps.push({ dt: 100_000 + i * 5_000, sellTokens: 25e12 })
    return record(steps, { t })
  }

  it('lets a runner ride instead of selling out at the last take-profit', () => {
    const plain = run(runner(), off)
    expect(plain.exits).toEqual([expect.stringMatching(/tier 1/), expect.stringMatching(/tier 2/)])
    const r = run(runner())
    expect(r.moonbag).toBe(true)
    expect(r.exits[0]).toMatch(/^free ride at \+5\d\.\d%/)
    expect(r.exits[1]).toMatch(/^moonbag trailing stop/)
    expect(r.peakGainPct).toBeGreaterThan(600)
    expect(r.pnlLamports).toBeGreaterThan(plain.pnlLamports)
    // Its slot was free again once the moonbag started riding.
    expect(r.slotMs).toBeLessThan(r.holdMs)
  })

  it('keeps the trade profitable when the coin crashes after the free ride', () => {
    // Pump to about +65%, then one wallet dumps: the moonbag is sold far below its stop.
    const steps: Step[] = []
    for (let i = 0; i < 6; i++) steps.push({ dt: 1_000 + i * 2_000, buy: 1.5e9 })
    steps.push({ dt: 20_000, sellTokens: 240e12, wallet: 7 })
    const r = run(record(steps))
    expect(r.exits).toEqual([expect.stringMatching(/^free ride/), expect.stringMatching(/^moonbag stop/)])
    expect(r.peakGainPct).toBeGreaterThan(50)
    // Stake, every fee and the secured 10% came out before the crash.
    expect(r.pnlLamports).toBeGreaterThan(0.1 * r.costLamports)
  })

  it('has no time limit: only a coin nobody trades any more ends the ride', () => {
    // Pumps, then trading stops; recorded for an hour.
    const steps: Step[] = []
    for (let i = 0; i < 6; i++) steps.push({ dt: 1_000 + i * 2_000, buy: 1.5e9 })
    const r = run(record(steps, { horizonMs: 3_600_000 }))
    // Neither MAX_HOLD_SECONDS (180s) nor STALE_SECONDS (30s) touches the moonbag.
    expect(r.exits).toEqual([expect.stringMatching(/^free ride/), 'moonbag: coin dead (no trades for 30 min)'])
    expect(r.holdMs).toBeGreaterThan(1_800_000)
  })

  it('counts a moonbag still riding when the recording ends at no more than its stop', () => {
    const steps: Step[] = []
    for (let i = 0; i < 6; i++) steps.push({ dt: 1_000 + i * 2_000, buy: 1.5e9 })
    for (let i = 0; i < 20; i++) steps.push({ dt: 20_000 + i * 40_000, buy: 0.05e9 }) // still trading, still up
    const r = run(record(steps))
    expect(r.exits[1]).toBe('recording ended (moonbag counted at its stop)')
    // A graduated coin was really sold at the end: that value counts in full.
    const sold = run(record(steps, { graduated: true }))
    expect(sold.exits[1]).toBe('graduated')
    expect(r.pnlLamports).toBeLessThan(sold.pnlLamports)
    expect(r.pnlLamports).toBeGreaterThan(0.1 * r.costLamports)
  })

  it('frees the position slot when the moonbag starts, so the next launch is not missed', () => {
    const one = { ...env, MAX_OPEN_POSITIONS: '1' }
    const recs = [runner(1_000), runner(21_000)]
    const count = (c: typeof on) => new Evaluator(recs, c).results(paramsFromConfig(c)).length
    expect(count(loadConfig(one))).toBe(1)
    expect(count(loadConfig({ ...one, MOONBAG_PCT: '25' }))).toBe(2)
  })
})

describe('recorder: runners stay replayable', () => {
  afterEach(() => vi.useRealTimers())

  it('keeps a thinned price path past the trade cap, and every dev trade', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    const dir = await mkdtemp(join(tmpdir(), 'recorder-'))
    const rec = new LaunchRecorder({ dataDir: dir, horizonMs: 900_000, maxTrades: 10 }, pino({ level: 'silent' }))
    const mint = Keypair.generate().publicKey
    const dev = Keypair.generate().publicKey
    const curve: CurveState = {
      virtualTokenReserves: 1_073_000_000_000_000n, virtualQuoteReserves: 30_000_000_000n, realTokenReserves: 793_100_000_000_000n,
      realQuoteReserves: 0n, tokenTotalSupply: 1_000_000_000_000_000n, complete: false, creator: dev, isMayhemMode: false, creatorFeeBps: 0n,
    }
    const launch = {
      mint, mintStr: mint.toBase58(), name: 'x', symbol: 'X', uri: 'u', creator: dev, dev, tokenProgram: dev, isMayhemMode: false, isHolderReward: false,
      quoteMint: dev, isSolPaired: true, curve, devBuyLamports: 0n, devBuyTokens: 0n, signature: 's', slot: 1, detectedAt: 0, detectedAtWall: Date.now(),
      source: 'ws' as const, executed: true,
    }
    rec.start(launch, { verdict: 'rejected', reason: '', creatorLaunches: 1, feeBps: { protocol: 95n, creator: 30n }, tokenOffset: OFFSET, initialRealTokenReserves: 793_100_000_000_000n })
    let vq = 30_000_000_000n
    const trade = (dtMs: number, dq: bigint, user = Keypair.generate().publicKey) => {
      vi.setSystemTime(Date.now() + dtMs)
      vq += dq
      const ev = { mint, user, isBuy: dq > 0n, solAmount: dq > 0n ? dq : -dq, virtualSolReserves: vq, virtualTokenReserves: (30_000_000_000n * 1_073_000_000_000_000n) / vq }
      rec.trade(ev as unknown as TradeEvent)
    }
    for (let i = 0; i < 10; i++) trade(100, 100_000_000n) // the first 10 trades, all kept
    for (let i = 0; i < 50; i++) trade(10, 1_000_000n) // 0.5s of tiny trades: none kept
    trade(10, -1_000_000n, dev) // the dev sells: kept
    trade(10, 3_000_000_000n) // a 20% jump: kept
    for (let i = 0; i < 3; i++) trade(1_000, 1_000_000n) // one per second: kept
    for (let i = 0; i < 40; i++) trade(1_000, 1_000_000n) // past 4x the cap: truncated
    await rec.flush()
    const [file] = await readdir(join(dir, 'launches'))
    const r = JSON.parse((await readFile(join(dir, 'launches', file!), 'utf8')).trim()) as LaunchRecord
    expect(r.thinnedFrom).toBe(10)
    expect(r.skippedTrades).toBe(50)
    expect(r.trades[10]![5]).toBe(0) // the dev's sell
    expect(r.trades).toHaveLength(40)
    expect(r.truncated).toBe(true)
    expect(r.summary.trades).toBe(90)
    // Nothing is known after the last row of a truncated recording: the replay stops there.
    expect(replayLaunch(r, rc()).holdMs).toBeLessThanOrEqual(r.trades[r.trades.length - 1]![0])
  })
})
