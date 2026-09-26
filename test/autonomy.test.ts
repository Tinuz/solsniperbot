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
import { TradeLedger } from '../src/notify/ledger.js'
import { Reporter, summaryText } from '../src/notify/reporter.js'
import { TelegramNotifier } from '../src/notify/telegram.js'
import { SolanaWs } from '../src/solana/ws.js'
import { OperatingCosts } from '../src/strategy/costs.js'
import type { Position } from '../src/trading/positions.js'
import { toJson } from '../src/util/json.js'
import { EXIT_CONFIG, EXIT_DEAD, RESTART_LIMITS, decideRestart } from '../src/util/restart-policy.js'
import { dataset, recordedUnder } from './records.js'

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
async function fakeTelegram(opts: { rateLimitFirst?: boolean; fail?: boolean; outages?: number } = {}) {
  const messages: { chat_id: string; text: string }[] = []
  let limited = !opts.rateLimitFirst
  let outages = opts.outages ?? 0
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      if (opts.fail) return res.end(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }))
      if (outages > 0) {
        outages--
        res.statusCode = 502
        return res.end('bad gateway')
      }
      if (!limited) {
        limited = true
        res.statusCode = 429
        return res.end(JSON.stringify({ ok: false, description: 'Too Many Requests', parameters: { retry_after: 1 } }))
      }
      if (req.url?.endsWith('/sendMessage')) messages.push(JSON.parse(body))
      res.end(JSON.stringify({ ok: true, result: req.url?.endsWith('/getUpdates') ? [] : {} }))
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

  it('retries through a network hiccup or Telegram outage instead of losing the message', async () => {
    const tg = await fakeTelegram({ outages: 2 })
    const n = new TelegramNotifier({ token: 'T', chatId: '42', apiUrl: tg.url }, log, '', [20, 20, 20])
    n.send('▶️ started')
    await n.flush()
    expect(tg.messages.map((m) => m.text)).toEqual(['▶️ started'])
    expect(n.failed).toBe(0)
    await tg.close()
  })

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
    const records = recordedUnder(dataset(600), p) // under these settings: ~2.25 SOL over the newest ~15 hours
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
function fakeEngine(cfg = loadConfig({ ...BASE, DATA_DIR: tmp(), TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '42', NOTIFY_TRADES: 'true', NOTIFY_COMMANDS: 'false' })) {
  const engine = new EventEmitter() as EventEmitter & Record<string, unknown>
  const closed: Position[] = []
  engine.cfg = cfg
  engine.positions = { history: () => closed, list: () => [] }
  engine.risk = { snapshot: () => ({ paused: false }), pause: () => {}, resume: () => {} }
  engine.survival = { paperRealizedLamports: 0n }
  engine.takeEarlyAlerts = () => []
  engine.status = () => ({
    uptimeSec: 2 * 86_400,
    risk: { paused: false },
    survival: { state: 'healthy', equitySol: 1.0234, peakEquitySol: 1.04, drawdownPct: 1.5, runwayTrades: 18 },
    tuning: { mode: 'paper', edge: { required: true, allowed: false, reason: 'collecting data: 120 launches over 1.0h (need 2000 over 24h)' }, last: null, probation: null, overrides: [] },
    costs: { perMonth: 69, currency: 'usd', perDaySol: 0.0123, accruedSol: 0.05, netLamports: -20_000_000 },
    recorder: { written: 25_123 },
    usage: { streamedMbPerDay: 3_300, heliusCreditsPerDay: 70_000 },
  })
  return { engine: engine as unknown as Engine, closed, cfg }
}

describe('reporter', () => {
  it('writes a daily summary in Dutch with status, results, costs and usage', () => {
    const now = 10 * 86_400_000
    const { engine } = fakeEngine()
    const ledger = new TradeLedger()
    const trade = (symbol: string, at: number, realized: bigint) =>
      ledger.add({ mint: symbol, symbol, status: 'closed', closedAt: at, realizedLamports: realized, costLamports: 50_000_000n, networkFeesLamports: 0n, valueLamports: 0n, reconciled: false } as Position)
    trade('WIN', now - 3_600_000, 80_000_000n)
    trade('MEH', now - 1_800_000, 45_000_000n)
    trade('OLD', now - 2 * 86_400_000, 0n)
    const text = summaryText(engine, ledger, now)
    expect(text).toContain('📊 Dagoverzicht')
    expect(text).toContain('observeert, koopt niet: verzamelt data: 120 launches in 1.0 u (nodig: 2000 in 24 u)')
    expect(text).toContain('Laatste 24 uur: 2 trades · 50% winst · +0,0250 SOL')
    expect(text).toContain('Zonder beste trade: −0,0050 SOL ❌')
    expect(text).toContain('netto na kosten −0,0200 SOL ❌')
    expect(text).toContain('Opgenomen: 25.123 launches · stream 3,2 GB/dag (≈70.000 Helius-credits/dag)')
  })

  it('reports alerts, closed trades, feed outages that last, and one summary a day', async () => {
    const tg = await fakeTelegram()
    const { engine, cfg } = fakeEngine()
    cfg.notify.telegram!.apiUrl = tg.url
    const clock = { now: Date.UTC(2026, 8, 25, 7, 5) }
    const r = new Reporter(engine, log, () => clock.now)
    await r.start()
    engine.emit('alert', 'autotune adopted ENTRY_MODE instant → momentum')
    engine.emit('event', { type: 'closed', data: { mint: 'M', symbol: 'MOON', status: 'closed', openedAt: clock.now - 95_000, closedAt: clock.now, closeReason: 'take profit +62.0% (tier 1)', realizedLamports: 70_000_000n, costLamports: 50_000_000n, networkFeesLamports: 0n, valueLamports: 0n, reconciled: false } as Position })
    engine.emit('feed', 'ws', false)
    engine.emit('feed', 'ws', true) // a quick reconnect is routine: no message
    expect(await r.maybeSummary()).toBe(true)
    expect(await r.maybeSummary()).toBe(false) // once per day
    await r.stop('SIGINT')
    const texts = tg.messages.map((m) => m.text)
    expect(texts[0]).toMatch(/^\[paper\] ▶️ Gestart · observeert/)
    expect(texts).toContain('[paper] ⚙️ Autotune nam over: ENTRY_MODE instant → momentum')
    expect(texts).toContain('[paper] 🟢 MOON +0,0200 SOL (+40,0%) · winst genomen op +62.0% (trede 1) · 2m')
    expect(texts.some((t) => t.includes('📊 Dagoverzicht'))).toBe(true)
    expect(texts.at(-1)).toBe('[paper] ⏹ Gestopt (handmatig gestopt)')
    expect(texts.some((t) => /stream (ligt|is terug)/.test(t))).toBe(false)
    await tg.close()
  }, 20_000)
})

describe('websocket feed health', () => {
  it('keeps a busy socket whose pongs are late, and drops one that goes silent', async () => {
    // autoPong off: the server never answers pings, like a pong stuck behind queued data.
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', autoPong: false })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    let streaming = true
    wss.on('connection', (sock) => {
      const timer = setInterval(() => streaming && sock.send('{"jsonrpc":"2.0","method":"x"}'), 20)
      sock.on('close', () => clearInterval(timer))
    })
    const ws = new SolanaWs(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, log, 'test', undefined, 50)
    ws.start()
    await new Promise((r) => setTimeout(r, 500))
    expect(ws.stats.reconnects).toBe(0) // data flows: alive, however late the pongs
    streaming = false
    await new Promise((r) => setTimeout(r, 400))
    expect(ws.stats.reconnects).toBeGreaterThan(0) // nothing at all for 3 intervals: dead
    ws.stop()
    await new Promise<void>((r) => wss.close(() => r()))
  })

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
