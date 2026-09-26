import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pino } from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import type { Engine } from '../src/engine.js'
import { TradeLedger, readJournalTrades, sincePaperReset } from '../src/notify/ledger.js'
import { dateTimeNl, localClock, startOfLocalDay, toDutch } from '../src/notify/nl.js'
import { Reporter } from '../src/notify/reporter.js'
import { RiskManager } from '../src/strategy/risk.js'
import type { Position } from '../src/trading/positions.js'

const log = pino({ level: 'silent' })
const dirs: string[] = []
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'telegram-'))
  dirs.push(d)
  return d
}

async function waitFor<T>(fn: () => T | undefined | false, ms = 5_000): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const v = fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('timed out')
}

type Sent = { chat_id: string; text: string; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } }

/** A fake Bot API: records what the bot sends and hands it queued updates. */
async function fakeTelegram() {
  const sent: Sent[] = []
  const answered: { callback_query_id: string; text?: string }[] = []
  let queue: Record<string, unknown>[] = []
  let nextId = 1
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const b = body ? JSON.parse(body) : {}
      const method = req.url?.split('/').pop()
      const reply = (result: unknown) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, result }))
      }
      if (method === 'sendMessage') sent.push(b)
      if (method === 'answerCallbackQuery') answered.push(b)
      if (method !== 'getUpdates') return reply(true)
      const due = queue.filter((u) => (u.update_id as number) >= (b.offset ?? 0))
      queue = queue.filter((u) => !due.includes(u))
      if (due.length) return reply(due)
      setTimeout(() => reply([]), 30)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  closers.push(() => new Promise<void>((r) => server.close(() => r())))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    sent,
    answered,
    texts: () => sent.map((m) => m.text),
    // In a private chat the sender's user id is the chat id.
    message: (text: string, at: number, chatId: number | string = 42, from: number = Number(chatId)) =>
      queue.push({ update_id: nextId++, message: { date: Math.floor(at / 1000), text, chat: { id: chatId }, from: { id: from } } }),
    tap: (data: string, chatId: number | string = 42, from: number = Number(chatId)) =>
      queue.push({ update_id: nextId++, callback_query: { id: `cb${nextId}`, data, from: { id: from }, message: { chat: { id: chatId } } } }),
  }
}

const position = (over: Partial<Position>): Position =>
  ({
    mint: 'MINT', symbol: 'WIF', status: 'open', paper: true, openedAt: 0, tokensBought: 1_000n, tokensHeld: 1_000n, costLamports: 50_000_000n,
    realizedLamports: 0n, networkFeesLamports: 0n, valueLamports: 50_000_000n, gainPct: 0, peakGainPct: 0, reconciled: false, sells: [], ...over,
  }) as Position

/** Just enough of an Engine for the reporter and its commands. */
function fakeEngine(env: Record<string, string>, dir = tmp()) {
  const engine = new EventEmitter() as EventEmitter & Record<string, unknown>
  const cfg = loadConfig({ RPC_URL: 'https://rpc.example.com', DRY_RUN: 'true', DATA_DIR: dir, TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '42', ...env })
  // The real one, saved where the engine saves it: pauses must survive a restart.
  const riskManager = new RiskManager(cfg, join(dir, 'risk-paper.json'))
  const risk = {
    get paused() {
      return riskManager.snapshot().paused
    },
    get pauseReason() {
      return riskManager.snapshot().pauseReason
    },
  }
  const open: Position[] = []
  const sold: string[] = []
  const vitals = { equitySol: 1.0 as number | null }
  engine.cfg = cfg
  engine.survival = { paperRealizedLamports: 0n }
  engine.risk = riskManager
  engine.takeEarlyAlerts = () => []
  engine.positions = {
    list: () => open,
    history: () => [],
    sellAll: async (reason: string) => {
      sold.push(reason)
      open.splice(0)
    },
  }
  engine.status = () => ({
    uptimeSec: 3_600,
    risk: riskManager.snapshot(),
    survival: { state: 'healthy', reason: 'ok', equitySol: vitals.equitySol, peakEquitySol: 1.0, drawdownPct: 0, runwayTrades: 18 },
    tuning: { mode: 'paper', edge: { required: true, allowed: true, reason: '45 forward trades made 0.0123 SOL' } },
    costs: null,
    recorder: { written: 18_849 },
    usage: { streamedMbPerDay: 900, heliusCreditsPerDay: null },
  })
  return { engine: engine as unknown as Engine, cfg, risk, riskManager, open, sold, vitals, dir }
}

async function started(env: Record<string, string>, clock: { now: number }, dir?: string) {
  const tg = await fakeTelegram()
  const f = fakeEngine({ TELEGRAM_API_URL: tg.url, ...env }, dir)
  await f.riskManager.load()
  const r = new Reporter(f.engine, log, () => clock.now)
  await r.start()
  closers.push(async () => {
    await r.stop('SIGTERM')
    await f.riskManager.flush()
  })
  return { tg, r, ...f }
}

// 25 Sep 2026, 12:00 in Amsterdam (UTC+2).
const NOON = Date.UTC(2026, 8, 25, 10, 0)

describe('telegram in Dutch', () => {
  it('translates the bot’s own messages, and leaves unknown ones as they are', () => {
    const cases: [string, string][] = [
      ['edge proven, trading enabled: 45 forward trades made 0.0123 SOL', '✅ Voordeel bewezen, de bot handelt: 45 trades onder deze instellingen maakten 0.0123 SOL'],
      [
        'buying paused, still recording: no proven edge: makes money, not one lucky trade (38 forward trades, -0.0210 SOL)',
        '⏸ Kopen gepauzeerd (blijft opnemen): geen bewezen voordeel: maakt winst, niet één geluksvoltreffer (38 trades onder deze instellingen, -0.0210 SOL)',
      ],
      [
        'collecting forward data: 12 launches over 0.4h recorded under these settings (need 60 over 3.0h)',
        'verzamelt data onder deze instellingen: 12 launches in 0.4 u onder deze instellingen (nodig: 60 in 3.0 u)',
      ],
      ['autotune: rolled back STOP_LOSS_PCT 25 → 30 (32 trades since adoption: new -0.0100 SOL vs previous 0.0040 SOL)', '↩️ Autotune draaide terug: STOP_LOSS_PCT 25 → 30 (32 trades sinds overname: nieuw -0.0100 SOL, vorige 0.0040 SOL)'],
      ['vitals healthy → defensive: drawdown 31.2% from peak: trade size halved', '🩺 Gezondheid gezond → defensief: 31.2% onder de piek: inzet gehalveerd'],
      ['bot died: insufficient funds to trade: 0.0100 SOL left, a viable trade needs 0.0300 SOL', '💀 De bot is dood: te weinig geld om te handelen: nog 0.0100 SOL, een zinnige trade vraagt 0.0300 SOL'],
      ['free ride at +53.0%: stake, fees and 10% profit secured, 25% moonbag rides', 'free ride op +53.0%: inleg, kosten en 10% winst veilig, 25% moonbag rijdt mee'],
      ['moonbag trailing stop: 41.2% off peak +380.0%', 'moonbag trailing stop: 41.2% onder de piek van +380.0%'],
      ['stop loss -25.3%', 'stop loss -25.3%'],
      ['no trading activity', 'geen handel meer'],
      ['something new the translator has never seen', 'something new the translator has never seen'],
    ]
    for (const [en, nl] of cases) expect(toDutch(en)).toBe(nl)
  })

  it('knows the local day and clock (Amsterdam, summer time)', () => {
    const at = Date.UTC(2026, 8, 25, 1, 30) // 03:30 local
    expect(startOfLocalDay(at, 'Europe/Amsterdam')).toBe(Date.UTC(2026, 8, 24, 22, 0))
    expect(localClock(at, 'Europe/Amsterdam')).toEqual({ hour: 3, day: '2026-09-25' })
    expect(dateTimeNl(at, 'Europe/Amsterdam')).toBe('25-09 03:30')
    expect(() => loadConfig({ RPC_URL: 'https://x.example', NOTIFY_TIMEZONE: 'Mars/Olympus' })).toThrow(/unknown time zone/)
    expect(() => loadConfig({ RPC_URL: 'https://x.example', NOTIFY_DIGEST_HOURS: '5' })).toThrow(/divide the day/)
  })
})

describe('trade ledger', () => {
  it('counts results with and without the best trade', () => {
    const l = new TradeLedger()
    for (const [s, pnl] of [['A', 30_000_000n], ['B', -5_000_000n], ['C', 2_000_000n]] as const) {
      l.add(position({ mint: s, symbol: s, status: 'closed', realizedLamports: 50_000_000n + pnl, valueLamports: 0n }), 1_000)
    }
    l.add(position({ mint: 'F', symbol: 'F', status: 'failed', networkFeesLamports: 1_000_000n }), 1_000)
    const s = TradeLedger.stats(l.since(0))
    expect(s).toMatchObject({ trades: 3, wins: 2, failed: 1, pnl: 26_000_000, withoutBest: -4_000_000 })
    expect(s.best?.symbol).toBe('A')
    expect(s.worst?.symbol).toBe('B')
  })

  it('starts from the trade journal the first time, paper or live as the bot runs', async () => {
    const dir = tmp()
    const lines = [
      { type: 'buy', at: 1, mint: 'A' },
      { type: 'close', at: 2_000, mint: 'A', symbol: 'AAA', paper: true, pnlLamports: '12000000', cost: '50000000' },
      { type: 'close', at: 3_000, mint: 'B', symbol: 'BBB', paper: false, pnlLamports: '-4000000', cost: '50000000' },
      { type: 'close', at: 10, mint: 'C', symbol: 'OLD', paper: true, pnlLamports: '1', cost: '1' },
    ]
    writeFileSync(join(dir, 'trades.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)
    const paper = await readJournalTrades(join(dir, 'trades.jsonl'), 1_000, true)
    expect(paper).toEqual([{ at: 2_000, mint: 'A', symbol: 'AAA', pnl: 12_000_000, cost: 50_000_000 }])
    const live = await readJournalTrades(join(dir, 'trades.jsonl'), 1_000, false)
    expect(live.map((e) => e.symbol)).toEqual(['BBB'])
  })

  it('in paper mode, counts only the trades since the paper wallet was last reset', () => {
    const e = (symbol: string, pnl: number) => ({ at: 0, mint: symbol, symbol, pnl, cost: 50_000_000 })
    const journal = [e('OLD1', 7_000_000), e('OLD2', -3_000_000), e('NEW1', 12_000_000), e('NEW2', -4_500_000), e('NEW3', 1_250_000)]
    // The fresh wallet has booked +8,750,000 lamports: exactly NEW1..NEW3.
    expect(sincePaperReset(journal, 8_750_000).map((x) => x.symbol)).toEqual(['NEW1', 'NEW2', 'NEW3'])
    expect(sincePaperReset(journal, 0)).toEqual([]) // just reset, nothing traded yet
    expect(sincePaperReset(journal, 123)).toHaveLength(5) // reset older than the journal window
  })
})

describe('digest and highlights', () => {
  it('sends a digest on the local clock, with the forward-test check', async () => {
    const clock = { now: NOON - 5 * 60_000 }
    const { tg, r, engine, open } = await started({ NOTIFY_COMMANDS: 'false', NOTIFY_DIGEST_HOURS: '6' }, clock)
    open.push(position({ mint: 'X', symbol: 'X' }), position({ mint: 'Y', symbol: 'Y', moonbag: true }))
    for (const [s, pnl, at] of [['A', 30_000_000n, 3], ['B', -5_000_000n, 2], ['C', 2_000_000n, 1]] as const) {
      engine.emit('event', { type: 'closed', data: position({ mint: s, symbol: s, status: 'closed', closedAt: NOON - at * 3_600_000, realizedLamports: 50_000_000n + pnl, valueLamports: 0n }) })
    }
    expect(await r.maybeDigest()).toBe(false) // 11:55
    clock.now = NOON + 60_000
    expect(await r.maybeDigest()).toBe(true) // 12:01
    expect(await r.maybeDigest()).toBe(false) // once per slot
    clock.now = NOON + 3_600_000
    expect(await r.maybeDigest()).toBe(false) // 13:01 is no slot
    const digest = await waitFor(() => tg.texts().find((t) => t.includes('📈')))
    expect(digest).toContain('📈 Laatste 6 uur')
    expect(digest).toContain('Trades: 3 trades · 67% winst · +0,0270 SOL')
    expect(digest).toContain('Zonder beste trade: −0,0030 SOL ❌')
    expect(digest).toContain('Beste: A +0,0300 SOL · slechtste: B −0,0050 SOL')
    expect(digest).toContain('Totaal sinds 25-09 09:00: 3 trades · +0,0270 SOL · zonder beste −0,0030 SOL ❌')
    expect(digest).toContain('Open: 1 positie · 1 moonbag')
    expect(digest).toContain('Status: handelt (45 trades onder deze instellingen maakten 0.0123 SOL)')
  })

  it('announces a free ride, runners at 3x and 5x, and new equity records, each once', async () => {
    const clock = { now: NOON }
    const { tg, engine, vitals } = await started({ NOTIFY_COMMANDS: 'false', NOTIFY_DIGEST_HOURS: '0' }, clock)
    const emit = (p: Partial<Position>) => engine.emit('event', { type: 'position', data: position({ openedAt: NOON, ...p }) })
    emit({ gainPct: 40, peakGainPct: 40 })
    const bag = { moonbag: true, moonbagAt: NOON, tokensHeld: 250n, realizedLamports: 57_000_000n, networkFeesLamports: 1_000_000n }
    emit({ ...bag, gainPct: 55, peakGainPct: 55 })
    emit({ ...bag, gainPct: 60, peakGainPct: 60 }) // still the same free ride
    emit({ ...bag, gainPct: 210, peakGainPct: 210, valueLamports: 38_000_000n })
    emit({ ...bag, gainPct: 250, peakGainPct: 250 }) // still 3x
    emit({ ...bag, gainPct: 420, peakGainPct: 420, valueLamports: 64_000_000n })
    vitals.equitySol = 1.03
    engine.emit('event', { type: 'closed', data: position({ mint: 'Z', status: 'closed', closedAt: NOON, realizedLamports: 60_000_000n, valueLamports: 0n }) })
    vitals.equitySol = 1.06
    engine.emit('event', { type: 'closed', data: position({ mint: 'Z2', status: 'closed', closedAt: NOON, realizedLamports: 60_000_000n, valueLamports: 0n }) })
    await waitFor(() => tg.texts().some((t) => t.includes('🏆')))
    const texts = tg.texts()
    expect(texts.filter((t) => t.includes('🎈'))).toEqual(['[paper] 🎈 Free ride: WIF op +55% — inleg en kosten terug, +0,0060 SOL winst veilig; 25% rijdt gratis mee'])
    expect(texts.filter((t) => t.includes('🚀'))).toEqual([
      '[paper] 🚀 WIF (moonbag) op 3x (+210%) · waarde nu 0,0380 SOL',
      '[paper] 🚀 WIF (moonbag) op 5x (+420%) · waarde nu 0,0640 SOL',
    ])
    expect(texts.filter((t) => t.includes('🏆'))).toEqual(['[paper] 🏆 Nieuw record: vermogen 1,0600 SOL (vorige melding 1,0000 SOL, +6,0%)'])
  })
})

describe('telegram commands', () => {
  it('answers only the owner’s chat, and ignores commands sent while the bot was down', async () => {
    const clock = { now: NOON }
    const { tg } = await started({ NOTIFY_DIGEST_HOURS: '0' }, clock)
    tg.message('/status', NOON - 10 * 60_000) // sent while down
    tg.message('/status', NOON, 999) // someone else
    tg.message('/help', NOON)
    await waitFor(() => tg.texts().some((t) => t.includes('Commando’s')))
    tg.message('/status@SniperBot', NOON)
    const status = await waitFor(() => tg.texts().find((t) => t.includes('🤖 Status')))
    expect(status).toContain('handelt (45 trades onder deze instellingen maakten 0.0123 SOL)')
    expect(status).toContain('Vermogen 1,0000 SOL')
    expect(tg.texts().filter((t) => t.includes('🤖 Status'))).toHaveLength(1)
    expect(tg.sent.every((m) => m.chat_id === '42')).toBe(true)
  })

  it('in a group, takes commands and taps only from the owners', async () => {
    const clock = { now: NOON }
    const group = await started({ NOTIFY_DIGEST_HOURS: '0', TELEGRAM_CHAT_ID: '-100', TELEGRAM_OWNER_IDS: '7' }, clock)
    group.tg.message('/pauze', NOON, -100, 8) // another member
    group.tg.message('/help', NOON, -100, 7) // the owner
    await waitFor(() => group.tg.texts().some((t) => t.includes('Commando’s')))
    expect(group.risk.paused).toBe(false)
    group.tg.tap('sellall:x', -100, 8)
    await waitFor(() => group.tg.answered.length === 1)
    expect(group.tg.answered[0]!.text).toBeUndefined() // ignored, not even "expired"

    // Without TELEGRAM_OWNER_IDS a group gets no commands at all.
    const open = await started({ NOTIFY_DIGEST_HOURS: '0', TELEGRAM_CHAT_ID: '-100' }, clock)
    open.tg.message('/pauze', NOON, -100, 7)
    open.tg.message('/pauze', NOON, 7, 7) // a private chat that isn't the configured one
    await new Promise((r) => setTimeout(r, 300))
    expect(open.risk.paused).toBe(false)
    expect(open.tg.texts().filter((t) => t.includes('⏸'))).toEqual([])
  })

  it('carries a pause saved by an older version over to the risk manager', async () => {
    const clock = { now: NOON }
    const dir = tmp()
    writeFileSync(join(dir, 'notify.json'), JSON.stringify({ pausedByUser: 'via Telegram (/pauze)' }))
    const a = await started({ NOTIFY_DIGEST_HOURS: '0' }, clock, dir)
    expect(a.risk).toMatchObject({ paused: true, pauseReason: 'via Telegram (/pauze)' })
    await a.r.stop('SIGTERM')
    expect(JSON.parse(readFileSync(join(dir, 'notify.json'), 'utf8')).pausedByUser).toBeUndefined()
  })

  it('pauses and resumes buying, keeps the pause across a restart, and never lifts another pause', async () => {
    const clock = { now: NOON }
    const a = await started({ NOTIFY_DIGEST_HOURS: '0' }, clock)
    a.tg.message('/pauze', NOON)
    await waitFor(() => a.risk.paused)
    expect(a.risk.pauseReason).toBe('via Telegram (/pauze)')
    await waitFor(() => a.tg.texts().some((t) => t.includes('⏸ Kopen gepauzeerd')))
    await a.r.stop('SIGTERM')
    await a.riskManager.flush()
    expect(JSON.parse(readFileSync(join(a.dir, 'risk-paper.json'), 'utf8'))).toMatchObject({ paused: true, pauseReason: 'via Telegram (/pauze)' })

    // Restarted: still paused.
    const b = await started({ NOTIFY_DIGEST_HOURS: '0' }, clock, a.dir)
    expect(b.risk).toMatchObject({ paused: true, pauseReason: 'via Telegram (/pauze)' })
    b.tg.message('/hervat', NOON)
    await waitFor(() => !b.risk.paused)
    await waitFor(() => b.tg.texts().some((t) => t.includes('▶️ Kopen hervat')))

    // The daily loss limit is not the owner's pause to lift.
    b.riskManager.pause('daily loss limit hit (-0.200 SOL)')
    b.tg.message('/resume', NOON)
    const refused = await waitFor(() => b.tg.texts().find((t) => t.includes('Kan niet hervatten')))
    expect(refused).toContain('daglimiet voor verlies bereikt (-0.200 SOL)')
    expect(b.risk.paused).toBe(true)
  })

  it('sells everything only after a confirmation tap, and pauses buying', async () => {
    const clock = { now: NOON }
    const { tg, open, sold, risk } = await started({ NOTIFY_DIGEST_HOURS: '0' }, clock)
    open.push(position({ mint: 'A', symbol: 'AAA' }), position({ mint: 'B', symbol: 'BBB', moonbag: true }))
    tg.message('/verkoopalles', NOON)
    const ask = await waitFor(() => tg.sent.find((m) => m.reply_markup))
    expect(ask.text).toContain('2 posities verkopen (AAA, BBB) en kopen pauzeren?')
    const [yes, no] = ask.reply_markup!.inline_keyboard[0]!
    expect(yes!.text).toBe('✅ Ja, verkoop alles')
    expect(no!.text).toBe('❌ Annuleer')

    tg.tap('sellall:wrong')
    await waitFor(() => tg.answered.length === 1)
    expect(tg.answered[0]!.text).toMatch(/Verlopen/)
    expect(sold).toEqual([])

    tg.message('/verkoopalles', NOON)
    const again = await waitFor(() => tg.sent.filter((m) => m.reply_markup)[1])
    tg.tap(again.reply_markup!.inline_keyboard[0]![0]!.callback_data)
    await waitFor(() => tg.texts().some((t) => t.includes('💸')))
    expect(sold).toEqual(['manual sell-all (Telegram)'])
    expect(risk).toMatchObject({ paused: true, pauseReason: 'via Telegram (/verkoopalles)' })
    expect(tg.texts().find((t) => t.includes('💸'))).toContain('2 van 2 verkocht')
  })
})
