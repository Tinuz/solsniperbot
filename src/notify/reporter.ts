import { join } from 'node:path'
import type { Engine } from '../engine.js'
import { type Position, positionPnl } from '../trading/positions.js'
import type { Logger } from '../util/logger.js'
import { readJson, writeJsonAtomic } from '../util/persist.js'
import { TelegramNotifier } from './telegram.js'

/** A feed outage is only reported once it lasts this long (reconnects are routine). */
const FEED_OUTAGE_MS = 60_000
const DAY_MS = 86_400_000

const sol = (lamports: bigint | number, digits = 4) => {
  const v = Number(lamports) / 1e9
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)} SOL`
}
const duration = (ms: number) => {
  const m = Math.round(ms / 60_000)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`
}
const tradePnl = (p: Position) => (p.status === 'failed' ? -p.networkFeesLamports : positionPnl(p))

type Status = ReturnType<Engine['status']>

function tradingLine(s: Status): string {
  const t = s.tuning
  if ('edge' in t && t.edge.required) return t.edge.allowed ? `trading (edge proven: ${t.edge.reason})` : `observing, not buying: ${t.edge.reason}`
  return s.risk.paused ? `buying paused: ${s.risk.pauseReason}` : 'trading'
}

/** The daily report: what the bot did, how it is doing, and what it costs. */
export function summaryText(engine: Engine, now = Date.now()): string {
  const s = engine.status()
  const since = Math.max(now - DAY_MS, now - s.uptimeSec * 1000)
  const recent = engine.positions.history().filter((p) => (p.closedAt ?? 0) >= since && (p.status === 'closed' || p.status === 'failed'))
  const wins = recent.filter((p) => tradePnl(p) > 0n).length
  const pnl = recent.reduce((a, p) => a + tradePnl(p), 0n)
  const window = now - since >= DAY_MS - 60_000 ? 'Last 24h' : `Since start (${duration(now - since)})`
  const v = s.survival
  const lines = [
    '📊 Daily summary',
    `Status: ${tradingLine(s)}`,
    `Vitals: ${v.state} · equity ${v.equitySol === null ? '–' : `${v.equitySol.toFixed(4)} SOL`} · drawdown ${v.drawdownPct.toFixed(1)}% · runway ${v.runwayTrades} trades`,
    `${window}: ${recent.length} trades${recent.length ? `, ${Math.round((wins / recent.length) * 100)}% wins, ${sol(pnl)}` : ''}`,
  ]
  if (s.costs) {
    const c = s.costs
    lines.push(
      c.perDaySol === null
        ? `Costs: ${c.perMonth} ${c.currency.toUpperCase()}/month (SOL price unknown)`
        : `Costs: ${c.perDaySol.toFixed(4)} SOL/day · accrued ${c.accruedSol.toFixed(4)} SOL · net after costs ${sol(c.netLamports)}${c.netLamports >= 0 ? ' ✅' : ' ❌'}`,
    )
  }
  const t = s.tuning
  if ('last' in t && t.last) lines.push(`Autotune: ${t.last.decision} (${t.last.reason})`)
  if ('probation' in t && t.probation) lines.push(`On probation: ${t.probation.changes.map((c) => `${c.env}=${c.to}`).join(', ')} · ${t.probation.trades}/${t.probation.neededTrades} trades`)
  if ('overrides' in t && t.overrides.length) lines.push(`Tuned: ${t.overrides.map((c) => `${c.env}=${c.to}`).join(', ')}`)
  const u = s.usage
  lines.push(
    `Recorded ${(s.recorder?.written ?? 0).toLocaleString()} launches · stream ${u.streamedMbPerDay >= 1024 ? `${(u.streamedMbPerDay / 1024).toFixed(1)} GB` : `${Math.round(u.streamedMbPerDay)} MB`}/day` +
      (u.heliusCreditsPerDay !== null ? ` (≈${u.heliusCreditsPerDay.toLocaleString()} Helius credits/day)` : ''),
  )
  return lines.join('\n')
}

/**
 * Tells the owner what the bot does while nobody is watching: starts and
 * stops, trading enabled or paused, adoptions and rollbacks, vitals changes,
 * death, feed outages, and a daily summary. Telegram only, for now.
 */
export class Reporter {
  private readonly tg?: TelegramNotifier
  private timer?: NodeJS.Timeout
  private readonly feedDown = new Map<string, { since: number; timer: NodeJS.Timeout; alerted: boolean }>()
  private lastSummaryDay?: string
  private readonly path: string

  constructor(
    private readonly engine: Engine,
    log: Logger,
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

  send(text: string): void {
    this.tg?.send(text)
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
    this.lastSummaryDay = (await readJson<{ lastSummaryDay?: string }>(this.path))?.lastSummaryDay
    this.engine.on('alert', (m) => this.send(m))
    this.engine.on('feed', (name, up) => this.onFeed(name, up))
    this.engine.on('event', (e) => {
      if (!cfg.notify.trades || e.type !== 'closed') return
      const p = e.data
      const pnl = tradePnl(p)
      const exit = p.status === 'failed' ? `buy failed: ${p.error ?? ''}` : (p.closeReason ?? '')
      const ride = p.moonbag ? ` · moonbag rode ${Math.round(((p.closedAt ?? p.moonbagAt ?? 0) - (p.moonbagAt ?? 0)) / 1000)}s` : ''
      this.send(`${pnl >= 0n ? '🟢' : '🔴'} ${p.symbol} ${sol(pnl)} (${exit})${ride}`)
    })
    const restarts = Number(process.env.SUPERVISOR_RESTARTS ?? 0)
    this.send(`▶️ started${restarts ? ` (restart #${restarts})` : ''} · ${tradingLine(this.engine.status())}`)
    this.timer = setInterval(() => void this.maybeSummary(), 60_000)
    this.timer.unref()
  }

  async stop(reason: string): Promise<void> {
    clearInterval(this.timer)
    for (const f of this.feedDown.values()) clearTimeout(f.timer)
    this.feedDown.clear()
    if (!this.tg) return
    // Death was already reported with its reason.
    if (reason !== 'dead') this.send(`⏹ stopped (${reason})`)
    await this.tg.flush()
  }

  /** Sends the daily summary once per UTC day, at NOTIFY_DAILY_HOUR_UTC. */
  async maybeSummary(): Promise<boolean> {
    const hour = this.engine.cfg.notify.dailyHourUtc
    if (!this.tg || hour < 0) return false
    const d = new Date(this.now())
    const day = d.toISOString().slice(0, 10)
    if (d.getUTCHours() !== hour || this.lastSummaryDay === day) return false
    this.lastSummaryDay = day
    await writeJsonAtomic(this.path, { lastSummaryDay: day }).catch(() => undefined)
    this.send(summaryText(this.engine, this.now()))
    return true
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
          this.send(`⚠️ ${name} feed down for over a minute; reconnecting`)
        }, FEED_OUTAGE_MS),
      }
      entry.timer.unref()
      this.feedDown.set(name, entry)
      return
    }
    if (!down) return
    clearTimeout(down.timer)
    this.feedDown.delete(name)
    if (down.alerted) this.send(`✅ ${name} feed back after ${duration(this.now() - down.since)}`)
  }
}
