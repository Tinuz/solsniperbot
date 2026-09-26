import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Keypair } from '@solana/web3.js'
import { pino } from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { LaunchRecorder } from '../src/learning/recorder.js'
import { replayConfigFrom, replayLaunch } from '../src/learning/replay.js'
import { neighbors, paramsFromConfig, paramsKey } from '../src/learning/tunable.js'
import { type WalletEntry, WalletBook, annotateSmartBuyers, earlyBuys, readWalletEntries } from '../src/learning/wallets.js'
import type { TradeEvent } from '../src/pump/events.js'
import type { CurveState } from '../src/pump/curve.js'
import { type MomentumSnapshot, decideMomentum } from '../src/strategy/momentum.js'
import { type Step, buildRecord } from './records.js'

const dirs: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const entry = (mint: string, until: number, buys: [string, 0 | 1][]): WalletEntry => ({ mint, t: until - 900_000, until, buys: buys.map(([a, h], i) => [i + 1, a, h]) })

describe('early buys', () => {
  it('logs each wallet’s first early buy and whether the price then doubled', () => {
    const steps: Step[] = [
      { dt: 500, buy: 0.2e9, wallet: 0 }, // the dev: never counted
      { dt: 1_000, buy: 0.5e9, wallet: 1 }, // early, and the price more than doubles after it
      { dt: 1_500, buy: 0.3e9, wallet: 4 }, // the bot itself
      ...Array.from({ length: 5 }, (_, i) => ({ dt: 10_000 + i * 1_000, buy: 4e9, wallet: 5 + i })),
      { dt: 21_000, buy: 1e9, wallet: 2 }, // near the top: no double after it
      { dt: 22_000, buy: 1e9, wallet: 1 }, // wallet 1 again: only its first buy counts
      { dt: 61_000, buy: 1e9, wallet: 3 }, // too late to be early
    ]
    const rec = buildRecord(steps)
    const addresses = ['DEV', 'W1', 'W2', 'W3', 'BOT', 'W5', 'W6', 'W7', 'W8', 'W9']
    const buys = earlyBuys(rec, addresses, new Set(['BOT']))
    const byAddress = Object.fromEntries(buys.map(([, a, hit]) => [a, hit]))
    expect(byAddress.W1).toBe(1)
    expect(byAddress.W2).toBe(0)
    expect(Object.keys(byAddress)).not.toContain('DEV')
    expect(Object.keys(byAddress)).not.toContain('BOT')
    expect(Object.keys(byAddress)).not.toContain('W3')
    expect(buys.filter(([, a]) => a === 'W1')).toHaveLength(1)
  })
})

describe('wallet book', () => {
  it('calls a wallet smart after enough early buys that turned into runners, well above the average', () => {
    const book = new WalletBook()
    for (let i = 0; i < 20; i++) book.add(entry(`M${i}`, 1_000 + i, [['NOISE', 0], [`N${i}`, i % 10 === 0 ? 1 : 0]]))
    book.add(entry('A', 2_000, [['SMART', 1], ['LUCKY', 1], ['MEH', 1]]))
    book.add(entry('B', 2_001, [['SMART', 1], ['LUCKY', 1], ['MEH', 0]]))
    expect(book.isSmart('SMART')).toBe(false) // two buys are not enough yet
    book.add(entry('C', 2_002, [['SMART', 1], ['MEH', 0]]))
    expect(book.baseRate).toBeLessThan(0.2)
    expect(book.isSmart('SMART')).toBe(true) // 3 of 3: score 3/5
    expect(book.isSmart('LUCKY')).toBe(false) // only 2 buys
    expect(book.isSmart('MEH')).toBe(false) // 1 of 3: score 1/5
    expect(book.isSmart('NOISE')).toBe(false) // 0 of 20
    expect(book.smartCount()).toBe(1)
    expect(book.knownUntil).toBe(2_002)
  })

  it('judges every launch only on launches that had finished before it (no look-ahead)', () => {
    // Ordinary wallets mostly miss: the average hit rate is low.
    const noise = Array.from({ length: 10 }, (_, i) => entry(`N${i}`, 1_000 + i, [[`X${i}`, 0], [`Y${i}`, 0]]))
    const entries = [...noise, entry('A', 10_000, [['SMART', 1]]), entry('B', 20_000, [['SMART', 1]]), entry('C', 30_000, [['SMART', 1]])]
    const launch = (mint: string, t: number) => ({ ...buildRecord([]), mint, t })
    const own = (mint: string, t: number) => ({ mint, t, until: t + 900_000, buys: [[3, 'SMART', 0]] as WalletEntry['buys'] })
    const d = launch('D', 25_000) // C still running: only 2 finished buys known
    const e = launch('E', 30_000) // C finished: 3 of 3
    annotateSmartBuyers([d, e], [...entries, own('D', 25_000), own('E', 30_000)].sort((x, y) => x.until - y.until))
    expect(d.smart).toEqual([])
    expect(e.smart).toEqual([3])
  })
})

describe('recorder', () => {
  it('logs the early buyers of every finished launch with their addresses, the bot’s own wallet aside', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    const dir = mkdtempSync(join(tmpdir(), 'wallets-'))
    dirs.push(dir)
    const bot = Keypair.generate().publicKey
    const logged: WalletEntry[] = []
    const rec = new LaunchRecorder({ dataDir: dir, horizonMs: 900_000, maxTrades: 100, ignoreWallets: [bot.toBase58()], onWallets: (e) => logged.push(e) }, pino({ level: 'silent' }))
    const mint = Keypair.generate().publicKey
    const dev = Keypair.generate().publicKey
    const curve: CurveState = {
      virtualTokenReserves: 1_073_000_000_000_000n, virtualQuoteReserves: 30_000_000_000n, realTokenReserves: 793_100_000_000_000n,
      realQuoteReserves: 0n, tokenTotalSupply: 1_000_000_000_000_000n, complete: false, creator: dev, isMayhemMode: false, creatorFeeBps: 0n,
    }
    const launch = {
      mint, mintStr: mint.toBase58(), name: 'x', symbol: 'X', uri: 'u', creator: dev, dev, tokenProgram: dev, isMayhemMode: false, isHolderReward: false,
      quoteMint: dev, isSolPaired: true, curve, devBuyLamports: 0n, devBuyTokens: 0n, signature: 's', slot: 1, detectedAt: 0, detectedAtWall: Date.now(), source: 'ws' as const, executed: true,
    }
    rec.start(launch, { verdict: 'rejected', reason: '', creatorLaunches: 1, feeBps: { protocol: 95n, creator: 30n }, tokenOffset: 279_900_000_000_000n, initialRealTokenReserves: 793_100_000_000_000n })
    let vq = 30_000_000_000n
    const buy = (user: ReturnType<typeof Keypair.generate>['publicKey'], sol: bigint) => {
      vi.setSystemTime(Date.now() + 1_000)
      vq += sol
      rec.trade({ mint, user, isBuy: true, solAmount: sol, virtualSolReserves: vq, virtualTokenReserves: (30_000_000_000n * 1_073_000_000_000_000n) / vq } as unknown as TradeEvent)
    }
    const early = Keypair.generate().publicKey
    buy(early, 500_000_000n)
    buy(bot, 100_000_000n)
    for (let i = 0; i < 4; i++) buy(Keypair.generate().publicKey, 5_000_000_000n)
    vi.setSystemTime(Date.now() + 900_000)
    rec.tick()
    await rec.flush()
    expect(logged).toHaveLength(1)
    const e = logged[0]!
    expect(e).toMatchObject({ mint: mint.toBase58(), t: 1_000_000, until: 1_900_000 })
    expect(e.buys.find(([, a]) => a === early.toBase58())?.[2]).toBe(1)
    expect(e.buys.some(([, a]) => a === bot.toBase58())).toBe(false)
    expect(readdirSync(join(dir, 'wallets'))).toHaveLength(1)
    expect((await readWalletEntries(dir))[0]).toEqual(e)
    expect(JSON.parse(readFileSync(join(dir, 'launches', readdirSync(join(dir, 'launches'))[0]!), 'utf8').trim()).smart).toBeUndefined()
  })
})

describe('smart-buyer entry', () => {
  const snap = (over: Partial<MomentumSnapshot>): MomentumSnapshot => ({
    ageMs: 5_000, buyers: 8, netBuyLamports: 3_000_000_000n, sellRatio: 0, mcapLamports: 30_000_000_000n, devSold: false, complete: false,
    earlyBuyLamports: 0n, topBuyerPct: 1, smartBuyers: 0, ...over,
  })

  it('waits for smart money when asked, and says so when it buys', () => {
    const m = loadConfig({ RPC_URL: 'https://x.example', ENTRY_MODE: 'momentum', MOMENTUM_MIN_SMART_BUYERS: '1' }).momentum
    expect(decideMomentum(snap({}), m, 0n)).toEqual({ action: 'wait' })
    expect(decideMomentum(snap({ smartBuyers: 1 }), m, 0n)).toMatchObject({ action: 'buy', reason: expect.stringMatching(/^8 buyers \(1 smart\)/) })
    const off = loadConfig({ RPC_URL: 'https://x.example', ENTRY_MODE: 'momentum' }).momentum
    expect(decideMomentum(snap({}), off, 0n)).toMatchObject({ action: 'buy' })
  })

  it('replays the same rule on recordings annotated with smart buyers', () => {
    const cfg = loadConfig({ RPC_URL: 'https://x.example', ENTRY_MODE: 'momentum', MOMENTUM_MIN_AGE_MS: '1000', MOMENTUM_MAX_AGE_MS: '10000', MOMENTUM_MIN_BUYERS: '2', MOMENTUM_MIN_NET_BUY_SOL: '0.5', MOMENTUM_MIN_SMART_BUYERS: '1' })
    const steps: Step[] = [
      { dt: 1_200, buy: 0.4e9, wallet: 1 },
      { dt: 1_400, buy: 0.4e9, wallet: 2 },
      { dt: 3_000, buy: 0.4e9, wallet: 3 },
    ]
    const rc = replayConfigFrom(cfg)
    expect(replayLaunch({ ...buildRecord(steps), smart: [] }, rc)).toMatchObject({ entered: false, skipReason: 'momentum window expired' })
    const withSmart = replayLaunch({ ...buildRecord(steps), smart: [3] }, rc)
    expect(withSmart.entered).toBe(true)
    expect(withSmart.entryMs).toBe(3_000 + cfg.paperLatencyMs) // right after the smart wallet bought
  })

  it('is tunable without changing the key of settings that don’t use it', () => {
    const base = paramsFromConfig(loadConfig({ RPC_URL: 'https://x.example', ENTRY_MODE: 'momentum' }))
    expect(paramsKey(base)).not.toMatch(/SMART/)
    expect(paramsKey({ ...base, momentumMinSmartBuyers: 1 })).toMatch(/"MOMENTUM_MIN_SMART_BUYERS":"1"/)
    expect(neighbors(base).some((n) => n.params.momentumMinSmartBuyers === 1)).toBe(true)
  })
})
