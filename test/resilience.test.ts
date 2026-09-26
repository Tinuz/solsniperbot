import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pino } from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { GrpcFeed } from '../src/feed/grpc-feed.js'
import { replayConfigFrom } from '../src/learning/replay.js'
import { type WalletEntry, WalletBook, annotateSmartBuyers } from '../src/learning/wallets.js'
import { RiskManager } from '../src/strategy/risk.js'
import { Survival } from '../src/strategy/survival.js'
import { Executor } from '../src/trading/executor.js'
import { txNetworkLamports } from '../src/trading/fees.js'
import { writeJsonAtomic } from '../src/util/persist.js'
import { buildRecord } from './records.js'

const log = pino({ level: 'silent' })
const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'resilience-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  vi.useRealTimers()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

// A stand-in for the Yellowstone client: every subscribe() hands out a fresh stream the test controls.
const grpc = vi.hoisted(() => ({ streams: [] as unknown[], failSubscribes: 0 }))
vi.mock('@triton-one/yellowstone-grpc', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  class FakeStream extends Emitter {
    writes: unknown[] = []
    destroyed = false
    write(req: unknown) {
      this.writes.push(req)
      return true
    }
    destroy() {
      this.destroyed = true
      this.emit('close')
    }
  }
  return {
    default: class {
      async connect() {}
      async subscribe() {
        if (grpc.failSubscribes > 0) {
          grpc.failSubscribes--
          throw new Error('UNAVAILABLE: connection refused')
        }
        const s = new FakeStream()
        grpc.streams.push(s)
        return s
      }
    },
  }
})
type FakeStream = EventEmitter & { destroyed: boolean; writes: unknown[]; destroy(): void }

describe('gRPC feed', () => {
  beforeEach(() => {
    grpc.streams.length = 0
    grpc.failSubscribes = 0
  })

  const start = async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })
    const feed = new GrpcFeed({ url: 'https://grpc.example.com', deshred: false }, log)
    const problems: string[] = []
    const status: boolean[] = []
    feed.on('problem', (m) => problems.push(m))
    feed.on('status', (up) => status.push(up))
    await feed.start()
    return { feed, problems, status, stream: (i: number) => grpc.streams[i] as FakeStream }
  }

  it('keeps reopening a closed stream until it works, and tells the owner when it keeps failing', async () => {
    const { feed, problems, stream } = await start()
    grpc.failSubscribes = 4
    stream(0).emit('close')
    // Retries after 1, 2, 4, 8 and 16 seconds: the fifth works.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(grpc.streams).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(grpc.streams).toHaveLength(2)
    expect(problems.some((p) => /cannot reopen the stream \(3 tries\)/.test(p))).toBe(true)
    expect(feed.stats()).toMatchObject({ connected: true, reconnects: 5 })
    feed.stop()
  })

  it('replaces a stream that stays open but delivers nothing', async () => {
    const { feed, problems, status, stream } = await start()
    await vi.advanceTimersByTimeAsync(30_000)
    stream(0).emit('data', { pong: { id: 1 } }) // pings are answered: alive
    await vi.advanceTimersByTimeAsync(50_000)
    expect(grpc.streams).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(30_000) // 70s of silence
    expect(stream(0).destroyed).toBe(true)
    expect(problems[0]).toMatch(/no data for \d+s; reconnecting/)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(grpc.streams).toHaveLength(2)
    expect(status).toEqual([true, false, true])
    expect(feed.stats().stalls).toBe(1)
    feed.stop()
  })

  it('survives a transaction it cannot decode', async () => {
    const { feed, problems, stream } = await start()
    const txs: unknown[] = []
    feed.on('tx', (t) => txs.push(t))
    // Not what a pump transaction looks like: the decoder throws.
    expect(() => stream(0).emit('data', { transaction: { slot: '1', transaction: { signature: 42, meta: { logMessages: null, innerInstructions: [] } } } })).not.toThrow()
    expect(problems[0]).toMatch(/1 pump transaction\(s\) could not be decoded/)
    feed.stop()
  })
})

describe('risk limits', () => {
  const cfg = loadConfig({ RPC_URL: 'https://rpc.example.com', DAILY_LOSS_LIMIT_SOL: '0.5' })

  it('keeps the daily loss limit and pauses across restarts, until the day ends', async () => {
    const path = join(tmp(), 'risk-paper.json')
    const clock = { now: Date.UTC(2026, 8, 26, 12) }
    const a = new RiskManager(cfg, path, undefined, () => clock.now)
    const alerts: string[] = []
    a.on('alert', (m) => alerts.push(m))
    a.recordRealized(-300_000_000n)
    a.recordRealized(-250_000_000n)
    expect(a.snapshot()).toMatchObject({ paused: true, pauseReason: expect.stringMatching(/^daily loss limit hit/) })
    expect(alerts).toEqual([expect.stringMatching(/daily loss limit hit \(-0.550 SOL today\): buying paused until 00:00 UTC/)])
    await a.flush()

    // A crash and a restart the same day: still paused, still counting.
    const b = new RiskManager(cfg, path, undefined, () => clock.now)
    await b.load()
    expect(b.snapshot()).toMatchObject({ paused: true, realizedTodayLamports: -550_000_000n })
    expect(b.canBuy({ openPositions: 0 })).toMatchObject({ pass: false })

    // The next day: a fresh budget.
    clock.now += 12 * 3_600_000
    const c = new RiskManager(cfg, path, undefined, () => clock.now)
    await c.load()
    expect(c.snapshot()).toMatchObject({ paused: false, realizedTodayLamports: 0n })
  })

  it('keeps a pause set by hand, but never a death pause (survival decides that at every start)', async () => {
    const path = join(tmp(), 'risk-live.json')
    const a = new RiskManager(cfg, path)
    a.pause('via Telegram (/pauze)')
    await a.flush()
    const b = new RiskManager(cfg, path)
    await b.load()
    expect(b.snapshot()).toMatchObject({ paused: true, pauseReason: 'via Telegram (/pauze)' })
    b.pause('dead: insufficient funds')
    await b.flush()
    const c = new RiskManager(cfg, path)
    await c.load()
    expect(c.snapshot().paused).toBe(false)
  })
})

describe('smart-money window', () => {
  const DAY = 86_400_000
  const e = (until: number, buys: [string, 0 | 1][]): WalletEntry => ({ mint: `M${until}`, t: until - 900_000, until, buys: buys.map(([a, h], i) => [i + 1, a, h]) })

  it('forgets early buys older than the window, so memory stays bounded', () => {
    const book = new WalletBook(14)
    const t0 = 100 * DAY
    for (let d = 0; d < 30; d++) book.add(e(t0 + d * DAY, [[`W${d}`, 0], ['EVERYDAY', 1]]))
    // 15 days kept (the window and today), older wallets dropped entirely.
    expect(book.size).toBe(16)
    expect(book.score('EVERYDAY')).toBeCloseTo(15 / 17, 6)
    expect(book.score('W0')).toBe(0)
    expect(book.baseRate).toBeCloseTo(0.5, 6)
    book.prune(t0 + 60 * DAY)
    expect(book.size).toBe(0)
    expect(book.baseRate).toBe(0)
  })

  it('judges replayed launches over the same window as the live book', () => {
    const t0 = 100 * DAY
    // Three hits long ago, noise ever since: smart back then, not any more.
    const old = [0, 1, 2].map((d) => e(t0 + d * DAY, [['ONCE', 1]]))
    const noise = Array.from({ length: 31 }, (_, i) => e(t0 + i * DAY + 1_000, Array.from({ length: 10 }, (_, j): [string, 0] => [`N${i}-${j}`, 0])))
    const launch = (t: number) => ({ ...buildRecord([]), mint: `L${t}`, t })
    const soon = launch(t0 + 4 * DAY)
    const late = launch(t0 + 30 * DAY)
    const own = (rec: { mint: string; t: number }) => ({ mint: rec.mint, t: rec.t, until: rec.t + 900_000, buys: [[5, 'ONCE', 0]] as WalletEntry['buys'] })
    annotateSmartBuyers([soon, late], [...old, ...noise, own(soon), own(late)].sort((a, b) => a.until - b.until))
    expect(soon.smart).toEqual([5])
    expect(late.smart).toEqual([]) // its hits fell out of the window
  })
})

describe('fees', () => {
  it('judges strategies on the most dynamic priority fees can cost, and books what a trade really paid', () => {
    const fixed = loadConfig({ RPC_URL: 'https://rpc.example.com', LANDING: 'rpc', PRIORITY_FEE_SOL: '0.0005' })
    const dynamic = loadConfig({ RPC_URL: 'https://rpc.example.com', LANDING: 'rpc', PRIORITY_FEE_SOL: '0.0005', PRIORITY_FEE_MODE: 'dynamic', PRIORITY_FEE_MAX_SOL: '0.003', BUY_SOL: '0.1' })
    expect(replayConfigFrom(fixed).buyNetworkLamports).toBe(505_000)
    expect(replayConfigFrom(dynamic).buyNetworkLamports).toBe(3_005_000)
    expect(txNetworkLamports(dynamic, 'buy')).toBe(505_000n) // the floor: what a quiet network costs
  })

  it('never trades above BUY_SOL: a BUY_SOL too small for the fees at their worst is refused at startup', () => {
    const base = { RPC_URL: 'https://rpc.example.com' }
    // Dynamic fees at the default cap make a round trip cost ~0.012 SOL: 0.05 SOL trades would lose 24% to fees.
    expect(() => loadConfig({ ...base, PRIORITY_FEE_MODE: 'dynamic' })).toThrow(/BUY_SOL=0.05 is below the smallest trade worth its fees, 0\.1201 SOL.*PRIORITY_FEE_MAX_SOL=0.005/)
    expect(() => loadConfig({ ...base, BUY_SOL: '0.02' })).toThrow(/BUY_SOL=0.02 is below the smallest trade worth its fees, 0\.0281 SOL/)
    expect(loadConfig({ ...base, PRIORITY_FEE_MODE: 'dynamic', PRIORITY_FEE_MAX_SOL: '0.001' }).buyLamports).toBe(50_000_000n)

    // However big the wallet, however the size is computed: never more than BUY_SOL.
    const live = { ...base, DRY_RUN: 'false', PRIVATE_KEY: '[1]', BUY_SOL: '0.05', DATA_DIR: tmp() }
    for (const env of [live, { ...live, SIZING: 'fraction', BUY_FRACTION_PCT: '50' }]) {
      const cfg = loadConfig(env)
      const v = new Survival(cfg, log).compute({ walletLamports: 100_000_000_000n, open: [] })
      expect(v.nextBuyLamports).toBe(50_000_000n)
    }
    // A small bankroll trades the smallest viable size, still within BUY_SOL.
    const small = new Survival(loadConfig({ ...live, SIZING: 'fraction', BUY_FRACTION_PCT: '1' }), log).compute({ walletLamports: 1_000_000_000n, open: [] })
    expect(small.nextBuyLamports).toBe(small.minViableBuyLamports)
    expect(small.nextBuyLamports <= 50_000_000n).toBe(true)
  })

  it('refuses an edge proof that could never be reached with the data it loads', () => {
    const base = { RPC_URL: 'https://rpc.example.com', RECORD_LAUNCHES: 'true' }
    expect(() => loadConfig({ ...base, AUTOTUNE_DAYS: '3', AUTOTUNE_MIN_HOURS: '96' })).toThrow(/AUTOTUNE_MIN_HOURS=96 can never be reached with AUTOTUNE_DAYS=3/)
    expect(loadConfig({ ...base, AUTOTUNE_DAYS: '3', AUTOTUNE_MIN_HOURS: '72' }).autotune.minHours).toBe(72)
    expect(loadConfig({ ...base, AUTOTUNE: 'off', REQUIRE_EDGE: 'false', AUTOTUNE_DAYS: '1', AUTOTUNE_MIN_HOURS: '96' }).autotune.days).toBe(1)
  })
})

describe('settling after a restart', () => {
  it('counts a transaction as landed only once it is confirmed, the commitment balances are read at', async () => {
    const at = (confirmationStatus: string | null, err: unknown = null) =>
      new Executor({ rpc: { getSignatureStatuses: async () => [confirmationStatus ? { slot: 1, confirmationStatus, err } : null] } } as unknown as ConstructorParameters<typeof Executor>[0])
    expect(await at('processed').txOutcome('sig')).toBe('unknown')
    expect(await at('confirmed').txOutcome('sig')).toBe('landed')
    expect(await at('finalized', { InstructionError: [2, { Custom: 6003 }] }).txOutcome('sig')).toBe('failed')
    expect(await at(null).txOutcome('sig')).toBe('unknown')
  })
})

describe('atomic writes', () => {
  it('never tears a file when writes to it overlap', async () => {
    const dir = tmp()
    const path = join(dir, 'state.json')
    const big = (n: number) => ({ n, rows: Array.from({ length: 20_000 }, (_, i) => ({ i, n })) })
    await Promise.all(Array.from({ length: 12 }, (_, n) => writeJsonAtomic(path, big(n), { compact: n % 2 === 0 })))
    expect(JSON.parse(readFileSync(path, 'utf8')).n).toBe(11) // the last one wins, whole
    expect(readdirSync(dir)).toEqual(['state.json']) // no temp files left behind
  })
})
