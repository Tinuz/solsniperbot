import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pino } from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { loadConfig, publicConfig } from '../src/config.js'
import type { Engine } from '../src/engine.js'
import { paramsFromConfig } from '../src/learning/tunable.js'
import { evaluateEdge } from '../src/learning/tuner.js'
import { Reporter, summaryText } from '../src/notify/reporter.js'
import { TelegramNotifier } from '../src/notify/telegram.js'
import { SolanaWs } from '../src/solana/ws.js'
import { OperatingCosts } from '../src/strategy/costs.js'
import type { Position } from '../src/trading/positions.js'
import { toJson } from '../src/util/json.js'
import { EXIT_CONFIG, EXIT_DEAD, RESTART_LIMITS, decideRestart } from '../src/util/restart-policy.js'
import { dataset } from './records.js'

const log = pino({ level: 'silent' })
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'autonomy-'))
  dirs.push(d)
  return d
}
const BASE = { RPC_URL: 'https://rpc.example.com', DRY_RUN: 'true' }

describe('restart policy', () => {
  const fresh = { crashes: 0 }
  const minute = 60_000

  it('never restarts a deliberate stop, a dead bot, or a bad configuration', () => {
    expect(decideRestart({ code: 0, signal: null, uptimeMs: minute }, fresh).restart).toBe(false)
    expect(decideRestart({ code: EXIT_DEAD, signal: null, uptimeMs: minute }, fresh)).toMatchObject({ restart: false, reason: expect.stringMatching(/fund a viable trade/) })
    expect(decideRestart({ code: EXIT_CONFIG, signal: null, uptimeMs: 500 }, fresh)).toMatchObject({ restart: false, reason: expect.stringMatching(/fix .env/) })
    expect(decideRestart({ code: 1, signal: null, uptimeMs: minute, stopRequested: true }, fresh).restart).toBe(false)
  })

  it('restarts crashes and hangs with growing delays, reset by a stable run, and never gives up', () => {
    let d = decideRestart({ code: 1, signal: null, uptimeMs: 1_000 }, fresh)
    expect(d).toMatchObject({ restart: true, delayMs: 5_000 })
    d = decideRestart({ code: null, signal: 'SIGKILL', uptimeMs: minute, hung: true }, d.state)
    expect(d).toMatchObject({ restart: true, delayMs: 10_000, reason: 'the bot stopped responding' })
    d = decideRestart({ code: 1, signal: null, uptimeMs: 1_000 }, d.state)
    expect(d.delayMs).toBe(20_000)
    // A long network outage: keeps trying, every 5 minutes at most.
    for (let i = 0; i < 50; i++) d = decideRestart({ code: 1, signal: null, uptimeMs: 1_000 }, d.state)
    expect(d).toMatchObject({ restart: true, delayMs: RESTART_LIMITS.maxDelayMs })
    d = decideRestart({ code: 1, signal: null, uptimeMs: RESTART_LIMITS.stableMs + 1 }, d.state)
    expect(d.delayMs).toBe(5_000)
  })
})

/** A fake Telegram Bot API that records messages and can answer 429 once. */
async function fakeTelegram(opts: { rateLimitFirst?: boolean; fail?: boolean } = {}) {
  const messages: { chat_id: string; text: string }[] = []
  let limited = !opts.rateLimitFirst
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      if (opts.fail) return res.end(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }))
      if (!limited) {
        limited = true
        res.statusCode = 429
        return res.end(JSON.stringify({ ok: false, description: 'Too Many Requests', parameters: { retry_after: 1 } }))
      }
      if (req.url?.endsWith('/sendMessage')) messages.push(JSON.parse(body))
      res.end(JSON.stringify({ ok: true, result: {} }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { url, messages, close: () => new Promise<void>((r) => server.close(() => r())) }
}

describe('telegram notifier', () => {
  it('delivers in order, tagged, and waits out a rate limit', async () => {
    const tg = await fakeTelegram({ rateLimitFirst: true })
    const n = new TelegramNotifier({ token: 'T', chatId: '42', apiUrl: tg.url }, log, '[paper]')
    n.send('one')
    n.send('two')
    await n.flush(10_000)
    expect(tg.messages.map((m) => m.text)).toEqual(['[paper] one', '[paper] two'])
    expect(tg.messages[0]!.chat_id).toBe('42')
    expect(n.sent).toBe(2)
    await tg.close()
  }, 15_000)

  it('drops a message Telegram refuses instead of blocking the queue', async () => {
    const tg = await fakeTelegram({ fail: true })
    const n = new TelegramNotifier({ token: 'T', chatId: 'nope', apiUrl: tg.url }, log)
    n.send('lost')
    await n.flush()
    expect(n.failed).toBe(1)
    await tg.close()
  })

  it('keeps the bot token out of the public config', () => {
    const cfg = loadConfig({ ...BASE, TELEGRAM_BOT_TOKEN: '123:secret', TELEGRAM_CHAT_ID: '42' })
    expect(cfg.notify.telegram?.token).toBe('123:secret')
    expect(toJson(publicConfig(cfg))).not.toContain('secret')
  })
})

describe('operating costs', () => {
  const HOUR = 3_600_000

  it('prices monthly costs in SOL, accrues them while running, and nets them against earnings', async () => {
    const clock = { now: 1_000_000 }
    const cfg = loadConfig({ ...BASE, DATA_DIR: tmp(), OPERATING_COST_PER_MONTH: '60.875', OPERATING_COST_CURRENCY: 'usd' })
    const costs = new OperatingCosts(cfg, log, { fetchPrice: async () => ({ usd: 100, eur: 90, at: clock.now }), now: () => clock.now })
    expect(costs.perDayLamports()).toBeNull() // unpriced until the first price arrives
    await costs.load()
    await new Promise((r) => setTimeout(r, 10))
    expect(costs.perDayLamports()).toBe(20_000_000) // 60.875 USD / 30.4375 days = 2 USD/day = 0.02 SOL at 100
    clock.now += 12 * HOUR
    costs.accrue()
    costs.bookClosed({ status: 'closed', realizedLamports: 60_000_000n, costLamports: 50_000_000n, networkFeesLamports: 0n, valueLamports: 0n, reconciled: false } as Position)
    const s = costs.status()
    expect(s.accruedSol).toBeCloseTo(0.01, 6)
    expect(s.earnedSol).toBeCloseTo(0.01, 6)
    expect(s.netLamports).toBe(0)
    await costs.stop()

    // The ledger survives a restart; downtime is not charged.
    const again = new OperatingCosts(cfg, log, { fetchPrice: async () => ({ usd: 100, eur: 90, at: clock.now }), now: () => clock.now })
    clock.now += 48 * HOUR
    await again.load()
    again.accrue()
    expect(again.status().accruedSol).toBeCloseTo(0.01, 6)
  })

  it('needs no price for costs in SOL, and is off by default', () => {
    const sol = new OperatingCosts(loadConfig({ ...BASE, DATA_DIR: tmp(), OPERATING_COST_PER_MONTH: '3.04375', OPERATING_COST_CURRENCY: 'sol' }), log)
    expect(sol.perDayLamports()).toBe(100_000_000)
    expect(new OperatingCosts(loadConfig({ ...BASE, DATA_DIR: tmp() }), log).enabled).toBe(false)
  })

  it('makes the edge gate demand profits that cover the costs', () => {
    const cfg = loadConfig(BASE)
    const p = paramsFromConfig(cfg)
    const o = { minLaunches: 200, minHours: 10, minTrainTrades: 30, minTestTrades: 12, minEdgePct: 1, maxChanges: 3 }
    const records = dataset(600) // profitable: ~2.25 SOL over the newest ~15 hours
    expect(evaluateEdge(records, cfg, p, { ...o, costPerDayLamports: 100_000_000 }, 0).status).toBe('proven')
    const expensive = evaluateEdge(records, cfg, p, { ...o, costPerDayLamports: 10_000_000_000 }, 0)
    expect(expensive.status).toBe('unproven')
    expect(expensive.gates.find((g) => g.name === 'covers its costs')?.pass).toBe(false)
    // Sampled data stands for more launches, so more profit per day.
    expect(evaluateEdge(records, cfg, p, { ...o, costPerDayLamports: 10_000_000_000, sampleStride: 5 }, 0).status).toBe('proven')
    const unpriced = evaluateEdge(records, cfg, p, { ...o, costPerDayLamports: null }, 0)
    expect(unpriced.gates.find((g) => g.name === 'covers its costs')).toMatchObject({ pass: false, detail: expect.stringMatching(/SOL price unknown/) })
  })
})

/** Just enough of an Engine for the reporter. */
function fakeEngine(cfg = loadConfig({ ...BASE, DATA_DIR: tmp(), TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '42', NOTIFY_TRADES: 'true' })) {
  const engine = new EventEmitter() as EventEmitter & Record<string, unknown>
  const closed: Position[] = []
  engine.cfg = cfg
  engine.positions = { history: () => closed }
  engine.status = () => ({
    uptimeSec: 2 * 86_400,
    risk: { paused: false },
    survival: { state: 'healthy', equitySol: 1.0234, drawdownPct: 1.5, runwayTrades: 18 },
    tuning: { mode: 'paper', edge: { required: true, allowed: false, reason: 'collecting data: 120 launches over 1.0h (need 2000 over 24h)' }, last: null, probation: null, overrides: [] },
    costs: { perMonth: 69, currency: 'usd', perDaySol: 0.0123, accruedSol: 0.05, netLamports: -20_000_000 },
    recorder: { written: 25_123 },
    usage: { streamedMbPerDay: 3_300, heliusCreditsPerDay: 70_000 },
  })
  return { engine: engine as unknown as Engine, closed, cfg }
}

describe('reporter', () => {
  it('writes a daily summary with status, results, costs and usage', () => {
    const now = 10 * 86_400_000
    const { engine, closed } = fakeEngine()
    closed.push(
      { symbol: 'WIN', status: 'closed', closedAt: now - 3_600_000, realizedLamports: 80_000_000n, costLamports: 50_000_000n, networkFeesLamports: 0n, valueLamports: 0n, reconciled: false } as Position,
      { symbol: 'OLD', status: 'closed', closedAt: now - 2 * 86_400_000, realizedLamports: 0n, costLamports: 50_000_000n, networkFeesLamports: 0n, valueLamports: 0n, reconciled: false } as Position,
    )
    const text = summaryText(engine, now)
    expect(text).toContain('observing, not buying: collecting data')
    expect(text).toContain('Last 24h: 1 trades, 100% wins, +0.0300 SOL')
    expect(text).toContain('net after costs −0.0200 SOL ❌')
    expect(text).toContain('Recorded 25,123 launches · stream 3.2 GB/day (≈70,000 Helius credits/day)')
  })

  it('reports alerts, closed trades, feed outages that last, and one summary a day', async () => {
    const tg = await fakeTelegram()
    const { engine, cfg } = fakeEngine()
    cfg.notify.telegram!.apiUrl = tg.url
    const clock = { now: Date.UTC(2026, 8, 25, 7, 5) }
    const r = new Reporter(engine, log, () => clock.now)
    await r.start()
    engine.emit('alert', 'autotune adopted ENTRY_MODE instant → momentum')
    engine.emit('event', { type: 'closed', data: { symbol: 'MOON', status: 'closed', closedAt: clock.now, closeReason: 'take profit 60%', realizedLamports: 70_000_000n, costLamports: 50_000_000n, networkFeesLamports: 0n, valueLamports: 0n, reconciled: false } as Position })
    engine.emit('feed', 'ws', false)
    engine.emit('feed', 'ws', true) // a quick reconnect is routine: no message
    expect(await r.maybeSummary()).toBe(true)
    expect(await r.maybeSummary()).toBe(false) // once per day
    await r.stop('SIGINT')
    const texts = tg.messages.map((m) => m.text)
    expect(texts[0]).toMatch(/^\[paper\] ▶️ started · observing/)
    expect(texts).toContain('[paper] autotune adopted ENTRY_MODE instant → momentum')
    expect(texts).toContain('[paper] 🟢 MOON +0.0200 SOL (take profit 60%)')
    expect(texts.some((t) => t.includes('📊 Daily summary'))).toBe(true)
    expect(texts.at(-1)).toBe('[paper] ⏹ stopped (SIGINT)')
    expect(texts.some((t) => t.includes('feed'))).toBe(false)
    await tg.close()
  }, 20_000)
})

describe('websocket feed health', () => {
  it('counts streamed bytes and reports a refused subscription', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    wss.on('connection', (sock) => {
      sock.on('message', (raw) => {
        const { id } = JSON.parse(raw.toString())
        sock.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32429, message: 'rate limit exceeded: credits exhausted' } }))
      })
    })
    const ws = new SolanaWs(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, log, 'test', 120_000)
    const refused = new Promise<string>((r) => ws.once('rejected', r))
    ws.subscribe('logsSubscribe', [], 'logsUnsubscribe', () => {})
    ws.start()
    expect(await refused).toMatch(/credits exhausted/)
    expect(ws.stats.bytes).toBeGreaterThan(50)
    ws.stop()
    await new Promise<void>((r) => wss.close(() => r()))
  })
})
