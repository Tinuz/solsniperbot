import { join } from 'node:path'
import type { Engine } from '../engine.js'
import type { Position } from '../trading/positions.js'
import type { Logger } from '../util/logger.js'
import { readJson, writeJsonAtomic } from '../util/persist.js'
import { type Command, TelegramCommands } from './commands.js'
import { type LedgerEntry, type LedgerStats, TradeLedger, readJournalTrades, sincePaperReset } from './ledger.js'
import { amountNl, dateTimeNl, durationNl, intNl, localClock, pctNl, solNl, startOfLocalDay, stateNl, toDutch } from './nl.js'
import { TelegramNotifier } from './telegram.js'

/** A feed outage is only reported once it lasts this long (reconnects are routine). */
const FEED_OUTAGE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
/** Price multiples of an open position worth a message. */
const MILESTONES = [3, 5, 10, 20, 50, 100]
/** A new equity record is announced once it beats the last announced one by this much. */
const RECORD_STEP = 1.05
/** How long the sell-all buttons stay valid. */
const CONFIRM_MS = 60_000
/** Pause reasons set from Telegram, so /hervat only lifts its own pause. */
const PAUSE_REASON = 'via Telegram (/pauze)'
const SELL_ALL_PAUSE_REASON = 'via Telegram (/verkoopalles)'
const OWN_PAUSES = new Set([PAUSE_REASON, SELL_ALL_PAUSE_REASON, 'manual'])

type Status = ReturnType<Engine['status']>

interface SavedState {
  lastSummaryDay?: string
  /** `YYYY-MM-DD HH` (local) of the last digest. */
  lastDigest?: string
  trades?: LedgerEntry[]
  /** Buying was paused from Telegram: stays paused across restarts. */
  pausedByUser?: string
  /** Last announced equity record, SOL. */
  recordSol?: number
}

const DECISIONS: Record<string, string> = {
  adopt: 'overgenomen',
  reject: 'afgewezen',
  'insufficient-data': 'te weinig data',
  'no-improvement': 'geen verbetering',
  skipped: 'overgeslagen',
  error: 'fout',
}

function tradingLine(s: Status): string {
  if (s.risk.paused) return `⏸ kopen gepauzeerd: ${toDutch(s.risk.pauseReason ?? 'handmatig')}`
  const t = s.tuning
  if ('edge' in t && t.edge.required) return t.edge.allowed ? `handelt (${toDutch(t.edge.reason)})` : `observeert, koopt niet: ${toDutch(t.edge.reason)}`
  return 'handelt'
}

const trades = (n: number) => `${n} ${n === 1 ? 'trade' : 'trades'}`
const winRate = (s: LedgerStats) => (s.trades ? `${Math.round((s.wins / s.trades) * 100)}% winst` : '')
const check = (v: number) => (v > 0 ? '✅' : '❌')

/** `12 trades · 58% winst · +0,0300 SOL`, then the same without the best trade. */
function resultLines(label: string, s: LedgerStats): string[] {
  if (!s.trades && !s.failed) return [`${label}: geen trades`]
  const lines = [`${label}: ${trades(s.trades)} · ${winRate(s)} · ${solNl(s.pnl)}${s.failed ? ` (${s.failed} mislukte ${s.failed === 1 ? 'koop' : 'kopen'})` : ''}`]
  if (s.trades > 1) lines.push(`Zonder beste trade: ${solNl(s.withoutBest)} ${check(s.withoutBest)}`)
  return lines
}

const multiple = (gainPct: number) => 1 + gainPct / 100

/** The daily report: what the bot did, how it is doing, and what it costs. */
export function summaryText(engine: Engine, ledger: TradeLedger, now = Date.now()): string {
  const s = engine.status()
  const v = s.survival
  const lines = [
    '📊 Dagoverzicht',
    `Status: ${tradingLine(s)}`,
    `Gezondheid: ${stateNl(v.state)} · vermogen ${v.equitySol === null ? '–' : amountNl(v.equitySol)} · ${pctNl(v.drawdownPct, 1, false)} onder de piek · ruimte voor ${v.runwayTrades} trades`,
    ...resultLines('Laatste 24 uur', TradeLedger.stats(ledger.since(now - DAY_MS, now + 1))),
  ]
  if (s.costs) {
    const c = s.costs
    lines.push(
      c.perDaySol === null
        ? `Kosten: ${c.perMonth} ${c.currency.toUpperCase()}/maand (SOL-koers onbekend)`
        : `Kosten: ${amountNl(c.perDaySol)}/dag · opgebouwd ${amountNl(c.accruedSol)} · netto na kosten ${solNl(c.netLamports)} ${check(c.netLamports)}`,
    )
  }
  const t = s.tuning
  if ('last' in t && t.last) lines.push(`Autotune: ${DECISIONS[t.last.decision] ?? t.last.decision} (${toDutch(t.last.reason)})`)
  if ('probation' in t && t.probation) lines.push(`Op proef: ${t.probation.changes.map((c) => `${c.env}=${c.to}`).join(', ')} · ${t.probation.trades}/${t.probation.neededTrades} trades`)
  if ('overrides' in t && t.overrides.length) lines.push(`Afgesteld: ${t.overrides.map((c) => `${c.env}=${c.to}`).join(', ')}`)
  const u = s.usage
  lines.push(
    `Opgenomen: ${intNl(s.recorder?.written ?? 0)} launches · stream ${u.streamedMbPerDay >= 1024 ? `${(u.streamedMbPerDay / 1024).toFixed(1).replace('.', ',')} GB` : `${Math.round(u.streamedMbPerDay)} MB`}/dag` +
      (u.heliusCreditsPerDay !== null ? ` (≈${intNl(u.heliusCreditsPerDay)} Helius-credits/dag)` : ''),
  )
  return lines.join('\n')
}

/**
 * Keeps the owner informed on Telegram, in Dutch: starts and stops, trading
 * enabled or paused, autotune, vitals, death, feed outages, a digest every
 * few hours, a daily summary, highlights (free rides, runners, records), and
 * every closed trade if asked. Also answers commands from the owner's chat.
 */
export class Reporter {
  private readonly tg?: TelegramNotifier
  private commands?: TelegramCommands
  private timer?: NodeJS.Timeout
  private saveTimer?: NodeJS.Timeout
  private readonly feedDown = new Map<string, { since: number; timer: NodeJS.Timeout; alerted: boolean }>()
  private readonly path: string
  private state: SavedState = {}
  private ledger = new TradeLedger()
  private startedAt = 0
  /** Highest milestone announced per open position. */
  private readonly milestones = new Map<string, number>()
  private readonly freeRides = new Set<string>()
  private confirm?: { nonce: string; until: number }

  constructor(
    private readonly engine: Engine,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {
    const cfg = engine.cfg
    if (cfg.notify.telegram) this.tg = new TelegramNotifier(cfg.notify.telegram, log, cfg.dryRun ? '[paper]' : '[LIVE]')
    this.path = join(cfg.dataDir, 'notify.json')
  }

  get enabled(): boolean {
    return this.tg !== undefined
  }

  get stats() {
    return this.tg ? { sent: this.tg.sent, failed: this.tg.failed } : null
  }

  /** Sends a message; the bot's English phrases are put into Dutch. */
  send(text: string, extra?: Record<string, unknown>): void {
    this.tg?.send(toDutch(text), extra)
  }

  /** Sends and waits, for messages that must go out before the process ends. */
  async sendNow(text: string): Promise<void> {
    this.send(text)
    await this.tg?.flush()
  }

  /** Call after the engine started. */
  async start(): Promise<void> {
    if (!this.tg) return
    const cfg = this.engine.cfg
    this.startedAt = this.now()
    this.state = (await readJson<SavedState>(this.path).catch(() => undefined)) ?? {}
    if (cfg.dryRun && cfg.survival.paperReset) {
      // A fresh paper wallet: its results start from zero, and so do the reports.
      this.ledger = new TradeLedger()
      this.save()
    } else if (this.state.trades) {
      this.ledger = new TradeLedger(this.state.trades)
    } else {
      // First run with the ledger: start from the trade journal, so the reports cover what came before
      // (in paper mode only since the paper wallet was last reset).
      let past = await readJournalTrades(join(cfg.dataDir, 'trades.jsonl'), this.now() - 8 * DAY_MS, cfg.dryRun).catch(() => [])
      if (cfg.dryRun) past = sincePaperReset(past, Number(this.engine.survival.paperRealizedLamports))
      this.ledger = new TradeLedger(past)
      this.save()
    }
    if (this.state.pausedByUser && !this.engine.risk.snapshot().paused) this.engine.risk.pause(this.state.pausedByUser)
    this.state.recordSol ??= this.engine.status().survival.peakEquitySol
    // Already-open positions: don't announce milestones they passed before this start.
    for (const p of this.engine.positions.list()) {
      this.milestones.set(p.mint, reached(multiple(p.peakGainPct)))
      if (p.moonbag) this.freeRides.add(p.mint)
    }

    this.engine.on('alert', (m) => this.send(m))
    this.engine.on('feed', (name, up) => this.onFeed(name, up))
    this.engine.on('event', (e) => {
      if (e.type === 'closed') this.onClosed(e.data)
      else if (e.type === 'position' && cfg.notify.highlights) this.onPosition(e.data)
    })
    const restarts = Number(process.env.SUPERVISOR_RESTARTS ?? 0)
    this.send(`▶️ Gestart${restarts ? ` (herstart #${restarts})` : ''} · ${tradingLine(this.engine.status())}${cfg.notify.commands ? '\nTyp /help voor de commando’s.' : ''}`)
    this.timer = setInterval(() => void this.tick(), 60_000)
    this.timer.unref()
    if (cfg.notify.commands && cfg.notify.telegram) {
      this.commands = new TelegramCommands(cfg.notify.telegram, { command: (c) => this.onCommand(c), button: (d) => this.onButton(d) }, this.log, this.now)
      this.commands.start()
    }
  }

  async stop(reason: string): Promise<void> {
    clearInterval(this.timer)
    for (const f of this.feedDown.values()) clearTimeout(f.timer)
    this.feedDown.clear()
    await this.commands?.stop()
    if (!this.tg) return
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      await this.persist()
    }
    // Death was already reported with its reason.
    if (reason !== 'dead') this.send(`⏹ Gestopt (${STOP_REASONS[reason] ?? reason})`)
    await this.tg.flush()
  }

  private async tick(): Promise<void> {
    // Resumed from the dashboard: the Telegram pause no longer holds.
    if (this.state.pausedByUser && !this.engine.risk.snapshot().paused) {
      this.state.pausedByUser = undefined
      this.save()
    }
    await this.maybeSummary()
    await this.maybeDigest()
  }

  /** Sends the daily summary once per UTC day, at NOTIFY_DAILY_HOUR_UTC. */
  async maybeSummary(): Promise<boolean> {
    const hour = this.engine.cfg.notify.dailyHourUtc
    if (!this.tg || hour < 0) return false
    const d = new Date(this.now())
    const day = d.toISOString().slice(0, 10)
    if (d.getUTCHours() !== hour || this.state.lastSummaryDay === day) return false
    this.state.lastSummaryDay = day
    await this.persist()
    this.send(summaryText(this.engine, this.ledger, this.now()))
    return true
  }

  /** Every NOTIFY_DIGEST_HOURS on the local clock (00, 06, 12, 18 for 6). */
  async maybeDigest(): Promise<boolean> {
    const every = this.engine.cfg.notify.digestHours
    if (!this.tg || every <= 0) return false
    const { hour, day } = localClock(this.now(), this.engine.cfg.notify.timeZone)
    const key = `${day} ${hour}`
    if (hour % every !== 0 || this.state.lastDigest === key) return false
    this.state.lastDigest = key
    await this.persist()
    this.send(this.digestText(every))
    return true
  }

  digestText(hours: number): string {
    const now = this.now()
    const s = this.engine.status()
    const recent = TradeLedger.stats(this.ledger.since(now - hours * HOUR_MS, now + 1))
    const open = this.engine.positions.list()
    const bags = open.filter((p) => p.moonbag).length
    const lines = [`📈 Laatste ${hours} uur`, ...resultLines('Trades', recent)]
    if (recent.best && recent.trades > 1) lines.push(`Beste: ${recent.best.symbol} ${solNl(recent.best.pnl)} · slechtste: ${recent.worst!.symbol} ${solNl(recent.worst!.pnl)}`)
    const first = this.ledger.first
    if (first) {
      const total = TradeLedger.stats(this.ledger.since(0, now + 1))
      lines.push(`Totaal sinds ${dateTimeNl(first.at, this.engine.cfg.notify.timeZone)}: ${trades(total.trades)} · ${solNl(total.pnl)} · zonder beste ${solNl(total.withoutBest)} ${check(total.withoutBest)}`)
    }
    lines.push(`Open: ${open.length - bags} ${open.length - bags === 1 ? 'positie' : 'posities'} · ${bags} ${bags === 1 ? 'moonbag' : 'moonbags'}`)
    const v = s.survival
    if (v.equitySol !== null) lines.push(`Vermogen ${amountNl(v.equitySol)} (piek ${amountNl(v.peakEquitySol)})`)
    lines.push(`Status: ${tradingLine(s)}`)
    return lines.join('\n')
  }

  // Events ---------------------------------------------------------------------

  private onClosed(p: Position): void {
    const cfg = this.engine.cfg
    const e = this.ledger.add(p, p.closedAt ?? this.now())
    this.save()
    this.milestones.delete(p.mint)
    this.freeRides.delete(p.mint)
    if (cfg.notify.trades) {
      const exit = p.status === 'failed' ? `buy failed: ${p.error ?? ''}` : (p.closeReason ?? '')
      const pct = e.cost ? ` (${pctNl((e.pnl / e.cost) * 100)})` : ''
      const held = p.closedAt ? ` · ${durationNl(p.closedAt - p.openedAt)}` : ''
      const ride = p.moonbag && p.moonbagAt ? ` · moonbag reed ${durationNl((p.closedAt ?? this.now()) - p.moonbagAt)} mee` : ''
      this.send(`${e.pnl >= 0 ? '🟢' : '🔴'} ${p.symbol} ${solNl(e.pnl)}${pct} · ${toDutch(exit)}${held}${ride}`)
    }
    if (cfg.notify.highlights && p.status === 'closed') this.checkRecord()
  }

  private onPosition(p: Position): void {
    if (p.status !== 'open' && p.status !== 'closing') return
    if (p.moonbag && !this.freeRides.has(p.mint)) {
      this.freeRides.add(p.mint)
      const secured = p.realizedLamports - p.costLamports - p.networkFeesLamports
      const riding = p.tokensBought > 0n ? Math.round((Number(p.tokensHeld) / Number(p.tokensBought)) * 100) : 0
      this.send(`🎈 Free ride: ${p.symbol} op ${pctNl(p.gainPct, 0)} — inleg en kosten terug, ${solNl(secured)} winst veilig; ${riding}% rijdt gratis mee`)
    }
    if (p.tokensBought === 0n) return
    const x = multiple(p.gainPct)
    const hit = reached(x)
    const before = this.milestones.get(p.mint) ?? 0
    if (hit > before) {
      this.milestones.set(p.mint, hit)
      this.send(`🚀 ${p.symbol}${p.moonbag ? ' (moonbag)' : ''} op ${hit}x (${pctNl(p.gainPct, 0)}) · waarde nu ${amountNl(Number(p.valueLamports) / 1e9)}`)
    } else if (!this.milestones.has(p.mint)) {
      this.milestones.set(p.mint, 0)
    }
  }

  private checkRecord(): void {
    const equity = this.engine.status().survival.equitySol
    const record = this.state.recordSol
    if (equity === null) return
    if (!record || record <= 0) {
      // Nothing to compare with yet (a live wallet before its first check).
      this.state.recordSol = equity
      return this.save()
    }
    if (equity < record * RECORD_STEP) return
    this.state.recordSol = equity
    this.save()
    this.send(`🏆 Nieuw record: vermogen ${amountNl(equity)} (vorige melding ${amountNl(record)}, ${pctNl((equity / record - 1) * 100)})`)
  }

  private onFeed(name: string, up: boolean): void {
    const down = this.feedDown.get(name)
    if (!up) {
      if (down) return
      const entry = {
        since: this.now(),
        alerted: false,
        timer: setTimeout(() => {
          entry.alerted = true
          this.send(`⚠️ ${name}-stream ligt al meer dan een minuut plat; opnieuw verbinden`)
        }, FEED_OUTAGE_MS),
      }
      entry.timer.unref()
      this.feedDown.set(name, entry)
      return
    }
    if (!down) return
    clearTimeout(down.timer)
    this.feedDown.delete(name)
    if (down.alerted) this.send(`✅ ${name}-stream is terug na ${durationNl(this.now() - down.since)}`)
  }

  // Commands -------------------------------------------------------------------

  private async onCommand(c: Command): Promise<void> {
    switch (ALIASES[c.name] ?? c.name) {
      case 'help':
        return this.send(HELP)
      case 'status':
        return this.send(this.statusText())
      case 'vandaag':
        return this.send(this.todayText())
      case 'posities':
        return this.send(this.positionsText())
      case 'pauze':
        return this.pause()
      case 'hervat':
        return this.resume()
      case 'verkoopalles':
        return this.askSellAll()
      default:
        return this.send(`Onbekend commando /${c.name}. Typ /help voor de lijst.`)
    }
  }

  statusText(): string {
    const s = this.engine.status()
    const v = s.survival
    const open = this.engine.positions.list()
    const bags = open.filter((p) => p.moonbag).length
    const today = TradeLedger.stats(this.ledger.since(startOfLocalDay(this.now(), this.engine.cfg.notify.timeZone), this.now() + 1))
    return [
      '🤖 Status',
      `${tradingLine(s)}`,
      `Vermogen ${v.equitySol === null ? '–' : amountNl(v.equitySol)} · piek ${amountNl(v.peakEquitySol)} · ${pctNl(v.drawdownPct, 1, false)} eronder`,
      `Gezondheid: ${stateNl(v.state)}${v.state === 'healthy' ? '' : ` (${toDutch(v.reason)})`}`,
      `Open: ${open.length - bags} ${open.length - bags === 1 ? 'positie' : 'posities'} · ${bags} ${bags === 1 ? 'moonbag' : 'moonbags'}`,
      `Vandaag: ${trades(today.trades)} · ${solNl(today.pnl)}`,
      `Draait ${durationNl(s.uptimeSec * 1000)} · ${intNl(s.recorder?.written ?? 0)} launches opgenomen`,
      ...(s.wallets?.tracked ? [`Slimme wallets: ${intNl(s.wallets.smart)} van ${intNl(s.wallets.tracked)} gevolgd (basis ${pctNl(s.wallets.baseRate * 100, 0, false)} hits)`] : []),
    ].join('\n')
  }

  todayText(): string {
    const tz = this.engine.cfg.notify.timeZone
    const now = this.now()
    const s = TradeLedger.stats(this.ledger.since(startOfLocalDay(now, tz), now + 1))
    const lines = ['📅 Vandaag', ...resultLines('Trades', s)]
    if (s.best && s.trades > 1) lines.push(`Beste: ${s.best.symbol} ${solNl(s.best.pnl)} · slechtste: ${s.worst!.symbol} ${solNl(s.worst!.pnl)}`)
    if (s.moonbags) lines.push(`Met moonbag: ${s.moonbags}`)
    return lines.join('\n')
  }

  positionsText(): string {
    const open = this.engine.positions.list()
    if (!open.length) return 'Er staan geen posities open.'
    const now = this.now()
    const rows = open
      .sort((a, b) => a.openedAt - b.openedAt)
      .map((p) => {
        const tag = p.moonbag ? ' 🎈' : p.status === 'closing' ? ' (verkoopt)' : p.status === 'opening' ? ' (koopt)' : ''
        return `• ${p.symbol}${tag} ${pctNl(p.gainPct, 0)} · waarde ${amountNl(Number(p.valueLamports) / 1e9)} · piek ${pctNl(p.peakGainPct, 0)} · ${durationNl(now - p.openedAt)}`
      })
    return [`📂 Open posities (${open.length})`, ...rows].join('\n')
  }

  private pause(): void {
    const r = this.engine.risk.snapshot()
    if (r.paused) return this.send(`Kopen staat al op pauze: ${toDutch(r.pauseReason ?? 'handmatig')}`)
    this.engine.risk.pause(PAUSE_REASON)
    this.state.pausedByUser = PAUSE_REASON
    this.save()
    this.send('⏸ Kopen gepauzeerd, ook na een herstart. Open posities worden gewoon verder beheerd. /hervat om weer te kopen.')
  }

  private resume(): void {
    const r = this.engine.risk.snapshot()
    if (!r.paused) return this.send(`Kopen stond niet op pauze.${this.edgeNote()}`)
    if (!OWN_PAUSES.has(r.pauseReason ?? 'manual')) return this.send(`Kan niet hervatten: gepauzeerd omdat ${toDutch(r.pauseReason ?? '')}`)
    this.engine.risk.resume()
    this.state.pausedByUser = undefined
    this.save()
    this.send(`▶️ Kopen hervat.${this.edgeNote()}`)
  }

  /** Resuming lifts the pause, not the edge gate. */
  private edgeNote(): string {
    const t = this.engine.status().tuning
    return 'edge' in t && t.edge.required && !t.edge.allowed ? ` Let op: de bot observeert nog (${toDutch(t.edge.reason)}).` : ''
  }

  private askSellAll(): void {
    const open = this.engine.positions.list().filter((p) => p.status === 'open')
    if (!open.length) return this.send('Er staan geen posities open.')
    const nonce = Math.random().toString(36).slice(2, 10)
    this.confirm = { nonce, until: this.now() + CONFIRM_MS }
    this.send(`⚠️ ${open.length} ${open.length === 1 ? 'positie' : 'posities'} verkopen (${open.map((p) => p.symbol).join(', ')}) en kopen pauzeren?`, {
      reply_markup: {
        inline_keyboard: [[{ text: '✅ Ja, verkoop alles', callback_data: `sellall:${nonce}` }, { text: '❌ Annuleer', callback_data: `cancel:${nonce}` }]],
      },
    })
  }

  private async onButton(data: string): Promise<string | undefined> {
    const [action, nonce] = data.split(':')
    const valid = this.confirm && this.confirm.nonce === nonce && this.now() <= this.confirm.until
    this.confirm = undefined
    if (!valid) return 'Verlopen; stuur /verkoopalles opnieuw'
    if (action === 'cancel') {
      this.send('Verkopen geannuleerd.')
      return 'Geannuleerd'
    }
    if (action !== 'sellall') return undefined
    this.engine.risk.pause(SELL_ALL_PAUSE_REASON)
    this.state.pausedByUser = SELL_ALL_PAUSE_REASON
    this.save()
    const before = this.engine.positions.list().filter((p) => p.status === 'open').length
    void this.engine.positions.sellAll('manual sell-all (Telegram)').then(() => {
      const left = this.engine.positions.list().length
      this.send(`💸 ${before - left} van ${before} verkocht${left ? `; ${left} nog niet (wordt opnieuw geprobeerd)` : ''}. Kopen staat op pauze; /hervat om weer te kopen.`)
    })
    return 'Bezig met verkopen…'
  }

  // State ----------------------------------------------------------------------

  private save(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      void this.persist()
    }, 5_000)
    this.saveTimer.unref()
  }

  private async persist(): Promise<void> {
    this.saveTimer = undefined
    this.state.trades = this.ledger.toJSON()
    await writeJsonAtomic(this.path, this.state).catch((err: Error) => this.log.warn({ err: err.message }, 'could not save notify state'))
  }
}

/** Highest milestone at or below `x` (0 below the first). */
function reached(x: number): number {
  let hit = 0
  for (const m of MILESTONES) if (x >= m) hit = m
  return hit
}

const ALIASES: Record<string, string> = {
  start: 'help',
  today: 'vandaag',
  positions: 'posities',
  pause: 'pauze',
  resume: 'hervat',
  sellall: 'verkoopalles',
}

const STOP_REASONS: Record<string, string> = {
  SIGINT: 'handmatig gestopt',
  SIGTERM: 'afgesloten door het systeem',
  uncaughtException: 'onverwachte fout; de supervisor herstart hem',
}

const HELP = [
  'Commando’s:',
  '/status — hoe de bot ervoor staat',
  '/vandaag — trades en resultaat van vandaag',
  '/posities — open posities en moonbags',
  '/pauze — stop met kopen; open posities worden verder beheerd',
  '/hervat — weer kopen',
  '/verkoopalles — alles verkopen en kopen pauzeren (met bevestiging)',
].join('\n')
