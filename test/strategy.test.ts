import { readFileSync } from 'node:fs'
import { Keypair, PublicKey } from '@solana/web3.js'
import { parse as parseDotenv } from 'dotenv'
import { describe, expect, it } from 'vitest'
import { type Config, loadConfig } from '../src/config.js'
import type { Launch, MintState } from '../src/feed/market.js'
import { TOKEN_2022_PROGRAM_ID } from '../src/pump/constants.js'
import type { CurveState } from '../src/pump/curve.js'
import { type ExitInput, type PositionBooks, decideExit, freeRide, moonbagFloorPct } from '../src/strategy/exits.js'
import { staticFilter } from '../src/strategy/filters.js'
import { decideMomentum, momentumSnapshot } from '../src/strategy/momentum.js'
import { RiskManager } from '../src/strategy/risk.js'

const baseEnv = { RPC_URL: 'https://rpc.example.com/?api-key=secret' }
const cfgWith = (env: Record<string, string> = {}): Config => loadConfig({ ...baseEnv, ...env })

const INITIAL_REAL = 793_100_000_000_000n

function curve(boughtTokens = 0n): CurveState {
  const vt = 1_073_000_000_000_000n
  const vq = 30_000_000_000n
  const cost = boughtTokens ? (boughtTokens * vq) / (vt - boughtTokens) + 1n : 0n
  return {
    virtualTokenReserves: vt - boughtTokens,
    virtualQuoteReserves: vq + cost,
    realTokenReserves: INITIAL_REAL - boughtTokens,
    realQuoteReserves: cost,
    tokenTotalSupply: 1_000_000_000_000_000n,
    complete: false,
    creator: Keypair.generate().publicKey,
    isMayhemMode: false,
    creatorFeeBps: 0n,
  }
}

function launch(over: Partial<Launch> = {}): Launch {
  const mint = Keypair.generate().publicKey
  return {
    mint,
    mintStr: mint.toBase58(),
    name: 'Good Coin',
    symbol: 'GOOD',
    uri: 'https://ipfs.io/ipfs/x',
    creator: Keypair.generate().publicKey,
    dev: Keypair.generate().publicKey,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    isMayhemMode: false,
    isHolderReward: false,
    quoteMint: PublicKey.default,
    isSolPaired: true,
    curve: curve(30_000_000_000_000n),
    devBuyLamports: 1_000_000_000n,
    devBuyTokens: 30_000_000_000_000n,
    signature: 'sig',
    slot: 100,
    detectedAt: 0,
    detectedAtWall: Date.now(),
    source: 'ws',
    executed: true,
    ...over,
  }
}

const ctx = { initialRealTokenReserves: INITIAL_REAL, creatorLaunches: 1 }

describe('config', () => {
  it('parses defaults and derives the websocket URL', () => {
    const c = cfgWith()
    expect(c.dryRun).toBe(true)
    expect(c.wsUrl).toBe('wss://rpc.example.com/?api-key=secret')
    expect(c.buyLamports).toBe(50_000_000n)
    expect(c.exits.takeProfit).toEqual([{ gainPct: 60, sellPct: 50 }, { gainPct: 150, sellPct: 100 }])
    expect(c.landing).toBe('jito')
  })

  it('picks Helius Sender automatically for Helius RPCs and enforces its minimum tip', () => {
    expect(cfgWith({ RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=x' }).landing).toBe('helius')
    expect(() => cfgWith({ RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=x', TIP_SOL: '0.0001' })).toThrow(/Helius Sender requires/)
  })

  it('refuses live trading without a key and rejects malformed values', () => {
    expect(() => cfgWith({ DRY_RUN: 'false' })).toThrow(/requires PRIVATE_KEY/)
    expect(() => cfgWith({ BUY_SOL: 'lots' })).toThrow(/BUY_SOL/)
    expect(() => cfgWith({ TAKE_PROFIT: '50:150' })).toThrow(/take-profit/)
    expect(() => cfgWith({ NAME_BLOCKLIST: '(' })).toThrow(/regex/)
  })

  it('.env.example is valid and matches the built-in defaults', () => {
    const example = parseDotenv(readFileSync(new URL('../.env.example', import.meta.url)))
    const fromExample = loadConfig(example)
    const defaults = loadConfig({ RPC_URL: example.RPC_URL! })
    expect(fromExample).toEqual(defaults)
  })

  it('sorts take-profit tiers and disables them with 0', () => {
    expect(cfgWith({ TAKE_PROFIT: '200:100,50:25' }).exits.takeProfit.map((t) => t.gainPct)).toEqual([50, 200])
    expect(cfgWith({ TAKE_PROFIT: '0' }).exits.takeProfit).toEqual([])
  })
})

describe('static filters', () => {
  const f = cfgWith().filters

  it('passes a normal launch', () => {
    expect(staticFilter(launch(), f, ctx)).toEqual({ pass: true })
  })

  it.each([
    ['non-SOL quote', { isSolPaired: false }, /not SOL-paired/],
    ['mayhem', { isMayhemMode: true }, /mayhem/],
    ['missing uri', { uri: '' }, /no metadata uri/],
    ['huge dev buy', { devBuyLamports: 9_000_000_000n }, /above max/],
    ['dev supply share', { devBuyTokens: 200_000_000_000_000n }, /dev holds 20.0%/],
    ['curve too far along', { curve: curve(400_000_000_000_000n) }, /sold/],
  ] as const)('rejects %s', (_label, over, reason) => {
    const v = staticFilter(launch(over as Partial<Launch>), f, ctx)
    expect(v.pass).toBe(false)
    if (!v.pass) expect(v.reason).toMatch(reason)
  })

  it('applies name regexes to name and symbol', () => {
    const c = cfgWith({ NAME_BLOCKLIST: 'rug|scam', NAME_ALLOWLIST: 'dog|cat' }).filters
    expect(staticFilter(launch({ name: 'Doggo', symbol: 'DOG' }), c, ctx).pass).toBe(true)
    expect(staticFilter(launch({ name: 'Dog Rug', symbol: 'DR' }), c, ctx).pass).toBe(false)
    expect(staticFilter(launch({ name: 'Frog', symbol: 'FRG' }), c, ctx).pass).toBe(false)
  })

  it('blocks serial launchers unless allowlisted', () => {
    const l = launch()
    expect(staticFilter(l, f, { ...ctx, creatorLaunches: 3 }).pass).toBe(false)
    const allow = cfgWith({ CREATOR_ALLOWLIST: l.dev.toBase58() }).filters
    expect(staticFilter(l, allow, { ...ctx, creatorLaunches: 3 }).pass).toBe(true)
    const block = cfgWith({ CREATOR_BLOCKLIST: l.dev.toBase58() }).filters
    expect(staticFilter(l, block, ctx)).toEqual({ pass: false, reason: 'creator blocklisted' })
  })
})

describe('exit policy', () => {
  const e = cfgWith({ TAKE_PROFIT: '50:40,120:100', STOP_LOSS_PCT: '20', TRAILING_STOP_PCT: '15', TRAILING_ARM_PCT: '30' }).exits
  const x = (over: Partial<ExitInput>): ExitInput => ({ gainPct: 0, peakGainPct: 0, ageMs: 1_000, idleMs: 0, devSold: false, tiersDone: 0, ...over })

  it('holds in the neutral zone', () => {
    expect(decideExit(x({ gainPct: 10, peakGainPct: 10 }), e)).toEqual({ action: 'hold' })
  })

  it('exits immediately when the dev sells, even in profit', () => {
    expect(decideExit(x({ gainPct: 80, peakGainPct: 80, devSold: true }), e)).toMatchObject({ action: 'sell', pct: 100, urgent: true, reason: 'dev sold' })
  })

  it('stops out at the stop loss', () => {
    expect(decideExit(x({ gainPct: -21 }), e)).toMatchObject({ action: 'sell', pct: 100, urgent: true })
  })

  it('takes profit tier by tier; the last tier sells everything', () => {
    expect(decideExit(x({ gainPct: 55, peakGainPct: 55 }), e)).toMatchObject({ action: 'sell', pct: 40, tier: 0 })
    expect(decideExit(x({ gainPct: 60, peakGainPct: 60, tiersDone: 1 }), e)).toEqual({ action: 'hold' })
    expect(decideExit(x({ gainPct: 125, peakGainPct: 125, tiersDone: 1 }), e)).toMatchObject({ action: 'sell', pct: 100, tier: 1 })
  })

  it('arms the trailing stop only after the arm threshold and measures drawdown on value', () => {
    // Peak +25% (not armed), now +5%: hold.
    expect(decideExit(x({ gainPct: 5, peakGainPct: 25 }), e)).toEqual({ action: 'hold' })
    // Peak +100% (value 2.0x), now +65% (1.65x): 17.5% off peak -> sell.
    expect(decideExit(x({ gainPct: 65, peakGainPct: 100, tiersDone: 1 }), e)).toMatchObject({ action: 'sell', pct: 100, urgent: true })
    // Peak +100%, now +75% (1.75x): 12.5% off peak -> hold.
    expect(decideExit(x({ gainPct: 75, peakGainPct: 100, tiersDone: 1 }), e)).toEqual({ action: 'hold' })
  })

  it('closes stale and overdue positions', () => {
    expect(decideExit(x({ ageMs: e.maxHoldMs }), e)).toMatchObject({ action: 'sell', reason: 'max hold time' })
    expect(decideExit(x({ idleMs: e.staleMs }), e)).toMatchObject({ action: 'sell', reason: 'no trading activity' })
  })
})

describe('moonbag (free ride)', () => {
  const e = cfgWith({ TAKE_PROFIT: '60:50,150:100', MOONBAG_PCT: '25', MOONBAG_SECURE_PCT: '10', MOONBAG_STOP_BUFFER_PCT: '5', MOONBAG_TRAILING_PCT: '40' }).exits
  // 0.05 SOL stake, 0.001 SOL paid in network fees so far, 0.0005 SOL per sell.
  const books = (over: Partial<PositionBooks> = {}): PositionBooks => ({
    heldFraction: 1,
    costLamports: 50_000_000,
    realizedLamports: 0,
    networkLamports: 1_000_000,
    sellNetworkLamports: 500_000,
    ...over,
  })
  const x = (over: Partial<ExitInput>): ExitInput => ({ gainPct: 0, peakGainPct: 0, ageMs: 1_000, idleMs: 0, devSold: false, tiersDone: 0, books: books(), ...over })

  it('is off by default: nothing changes', () => {
    const off = cfgWith({ TAKE_PROFIT: '60:50,150:100' }).exits
    expect(off.moonbag).toMatchObject({ pct: 0, securePct: 10, stopBufferPct: 5, trailingPct: 40, staleMs: 1_800_000, maxHoldMs: 0, max: 10 })
    expect(decideExit(x({ gainPct: 160, peakGainPct: 160, tiersDone: 1 }), off)).toMatchObject({ action: 'sell', pct: 100, tier: 1 })
  })

  it('sells all but the moonbag once that brings back the stake, every fee and the secured profit', () => {
    // Needed: 0.05 * 1.10 + 0.001 + 2 sells * 0.0005 = 0.057 SOL; 75% of the tokens fetch that at +52%.
    expect(decideExit(x({ gainPct: 51, peakGainPct: 51 }), e)).toEqual({ action: 'hold' })
    const d = decideExit(x({ gainPct: 53, peakGainPct: 53 }), e)
    expect(d).toMatchObject({ action: 'sell', pct: 75, moonbag: true, urgent: false })
    expect(d.action === 'sell' && d.reason).toMatch(/^free ride at \+53\.0%/)
    // By construction the moonbag is free: the sale alone covers stake, fees and profit.
    for (let gain = 0; gain <= 500; gain += 7) {
      const b = books()
      const ride = freeRide({ gainPct: gain, books: b }, e.moonbag)
      if (!ride) continue
      const proceeds = (ride / 100) * b.heldFraction * b.costLamports * (1 + gain / 100)
      expect(proceeds).toBeGreaterThanOrEqual(b.costLamports * 1.1 + b.networkLamports + 2 * b.sellNetworkLamports - 1)
    }
  })

  it('counts what earlier take-profits already brought in', () => {
    // Tier 1 sold half at +60% (0.04 SOL); selling another quarter must bring the rest.
    const after = books({ heldFraction: 0.5, realizedLamports: 40_000_000, networkLamports: 1_500_000 })
    expect(decideExit(x({ gainPct: 35, peakGainPct: 60, tiersDone: 1, books: after }), e)).toEqual({ action: 'hold' })
    expect(decideExit(x({ gainPct: 45, peakGainPct: 60, tiersDone: 1, books: after }), e)).toMatchObject({ action: 'sell', pct: 50, moonbag: true })
    // Already down to the moonbag's size and paid for: switch to the moonbag rules without selling.
    const small = books({ heldFraction: 0.2, realizedLamports: 60_000_000, networkLamports: 1_500_000 })
    expect(decideExit(x({ gainPct: 20, peakGainPct: 60, tiersDone: 1, books: small }), e)).toMatchObject({ action: 'moonbag' })
  })

  it('never starts one at a loss, without books, or when every moonbag slot is taken', () => {
    expect(decideExit(x({ gainPct: -30 }), e)).toMatchObject({ action: 'sell', pct: 100, reason: 'stop loss -30.0%' })
    expect(decideExit(x({ gainPct: 70, peakGainPct: 70, books: undefined }), e)).toMatchObject({ action: 'sell', pct: 50, tier: 0 })
    expect(decideExit(x({ gainPct: 70, peakGainPct: 70, moonbagsFull: true }), e)).toMatchObject({ action: 'sell', pct: 50, tier: 0 })
    expect(decideExit(x({ gainPct: 160, peakGainPct: 160, tiersDone: 1, moonbagsFull: true }), e)).toMatchObject({ action: 'sell', pct: 100 })
  })

  it('rides the moonbag on its own rules: break-even stop and wide trailing stop, no time limit', () => {
    // A quarter of the tokens: cost 0.0125 SOL, the sell's 0.0005 SOL fee is 4% of it, so the stop sits at +9%.
    const bag = (over: Partial<ExitInput>) => x({ moonbag: true, books: books({ heldFraction: 0.25, realizedLamports: 57_000_000, networkLamports: 1_500_000 }), ...over })
    expect(moonbagFloorPct(bag({}).books, e.moonbag)).toBeCloseTo(9)
    expect(decideExit(bag({ gainPct: 9.5, peakGainPct: 60 }), e)).toEqual({ action: 'hold' })
    expect(decideExit(bag({ gainPct: 8.9, peakGainPct: 60 }), e)).toMatchObject({ action: 'sell', pct: 100, urgent: true, reason: 'moonbag stop at +9.0%' })
    // Peak 4x, now 2.5x: 37.5% off, keeps riding; at 2.4x (40% off) it is sold.
    expect(decideExit(bag({ gainPct: 150, peakGainPct: 300 }), e)).toEqual({ action: 'hold' })
    expect(decideExit(bag({ gainPct: 140, peakGainPct: 300 }), e)).toMatchObject({ action: 'sell', pct: 100, reason: /^moonbag trailing stop/ })
    // Take-profit tiers, the normal stop, max hold and stale exits no longer apply: it rides as long as the coin runs.
    expect(decideExit(bag({ gainPct: 200, peakGainPct: 200, idleMs: 600_000, ageMs: 86_400_000 }), e)).toEqual({ action: 'hold' })
    // Only a coin nobody traded for half an hour is dead.
    expect(decideExit(bag({ gainPct: 200, peakGainPct: 200, idleMs: 1_800_000 }), e)).toMatchObject({ action: 'sell', reason: 'moonbag: coin dead (no trades for 30 min)' })
    // An optional hard limit, for whoever wants one.
    const capped = cfgWith({ MOONBAG_PCT: '25', MOONBAG_MAX_HOLD_SECONDS: '3600' }).exits
    expect(decideExit(bag({ gainPct: 200, peakGainPct: 200, ageMs: 3_600_000 }), capped)).toMatchObject({ action: 'sell', reason: 'moonbag max hold time' })
    expect(decideExit(bag({ gainPct: 200, peakGainPct: 200, devSold: true }), e)).toMatchObject({ action: 'sell', pct: 100, reason: 'moonbag: dev sold' })
    const noTrail = { ...e, moonbag: { ...e.moonbag, trailingPct: 0 } }
    expect(decideExit(bag({ gainPct: 20, peakGainPct: 900 }), noTrail)).toEqual({ action: 'hold' })
  })

})

describe('momentum entry', () => {
  const c = cfgWith({ ENTRY_MODE: 'momentum', MOMENTUM_MIN_AGE_MS: '1000', MOMENTUM_MAX_AGE_MS: '10000', MOMENTUM_MIN_BUYERS: '3', MOMENTUM_MIN_NET_BUY_SOL: '1' })
  const setup = () => {
    const l = launch({ devBuyLamports: 500_000_000n, detectedAtWall: 10_000 })
    const s: MintState = {
      mintStr: l.mintStr,
      launch: l,
      curve: l.curve,
      curveSlot: 1,
      complete: false,
      createdAtWall: 10_000,
      lastTradeAtWall: 10_000,
      trades: 1,
      buys: 1,
      sells: 0,
      buyVolume: 500_000_000n,
      sellVolume: 0n,
      buyers: new Set([l.dev.toBase58()]),
      holders: new Map(),
      earlyBuyVolume: 0n,
      devStr: l.dev.toBase58(),
      devSold: false,
      watched: false,
    }
    return { l, s }
  }

  it('waits for age, buyers and net inflow, then buys', () => {
    const { l, s } = setup()
    expect(decideMomentum(momentumSnapshot(s, l, 10_500), c.momentum, c.filters.maxEntryMcapLamports).action).toBe('wait')
    for (let i = 0; i < 3; i++) s.buyers.add(Keypair.generate().publicKey.toBase58())
    expect(decideMomentum(momentumSnapshot(s, l, 11_500), c.momentum, c.filters.maxEntryMcapLamports).action).toBe('wait') // not enough net inflow
    s.buyVolume += 1_500_000_000n
    expect(decideMomentum(momentumSnapshot(s, l, 11_500), c.momentum, c.filters.maxEntryMcapLamports).action).toBe('buy')
  })

  it('rejects on dev sell and on expiry', () => {
    const { l, s } = setup()
    s.devSold = true
    expect(decideMomentum(momentumSnapshot(s, l, 11_000), c.momentum, c.filters.maxEntryMcapLamports)).toMatchObject({ action: 'reject', reason: /dev sold/ })
    s.devSold = false
    expect(decideMomentum(momentumSnapshot(s, l, 30_000), c.momentum, c.filters.maxEntryMcapLamports)).toMatchObject({ action: 'reject', reason: /expired/ })
  })

  it('skips coins with bundled insiders or one big holder (the dev aside)', () => {
    const strict = cfgWith({ ENTRY_MODE: 'momentum', MOMENTUM_MAX_EARLY_BUY_SOL: '1', MOMENTUM_MAX_TOP_BUYER_PCT: '5' }).momentum
    const { l, s } = setup()
    const decide = () => decideMomentum(momentumSnapshot(s, l, 11_000), strict, c.filters.maxEntryMcapLamports)
    s.earlyBuyVolume = 1_500_000_000n
    expect(decide()).toMatchObject({ action: 'reject', reason: /insiders bought 1.50 SOL in the first 0.5s/ })
    s.earlyBuyVolume = 500_000_000n
    s.holders.set(l.dev.toBase58(), (s.curve.tokenTotalSupply * 40n) / 100n) // the dev's own bag is a separate filter
    s.holders.set(Keypair.generate().publicKey.toBase58(), (s.curve.tokenTotalSupply * 6n) / 100n)
    expect(decide()).toMatchObject({ action: 'reject', reason: /one wallet holds 6.0% of the supply/ })
    // Off by default.
    expect(decideMomentum(momentumSnapshot(s, l, 11_000), c.momentum, c.filters.maxEntryMcapLamports).action).not.toBe('reject')
  })
})

describe('risk manager', () => {
  it('enforces position count and buy rate', () => {
    const r = new RiskManager(cfgWith({ MAX_OPEN_POSITIONS: '2', MAX_BUYS_PER_MINUTE: '2' }))
    expect(r.canBuy({ openPositions: 2 })).toMatchObject({ pass: false, reason: /max open/ })
    r.recordBuy()
    r.recordBuy()
    expect(r.canBuy({ openPositions: 0 })).toMatchObject({ pass: false, reason: /rate limit/ })
  })

  it('pauses when the daily loss limit is hit', () => {
    const r = new RiskManager(cfgWith({ DAILY_LOSS_LIMIT_SOL: '0.5' }))
    r.recordRealized(-300_000_000n)
    expect(r.snapshot().paused).toBe(false)
    r.recordRealized(-250_000_000n)
    expect(r.snapshot()).toMatchObject({ paused: true })
    expect(r.canBuy({ openPositions: 0 }).pass).toBe(false)
  })
})
