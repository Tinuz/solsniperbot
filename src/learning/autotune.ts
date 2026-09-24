import { EventEmitter } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { Config } from '../config.js'
import type { Logger } from '../util/logger.js'
import { Journal, readJson, writeJsonAtomic } from '../util/persist.js'
import { SUMMARY_HEADERS, sol, summaryRow, table } from './report.js'
import {
  type ParamChange,
  type TunableParams,
  applyParams,
  diffParams,
  paramsFromConfig,
  paramsKey,
  withinLimits,
} from './tunable.js'
import type { EdgeResult, Gate, ProbationResult, TuningResult } from './tuner.js'
import { type TuningJob, type TuningJobResult, runTuningJob } from './tuning-job.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** Probation and the edge are checked at least this often. */
const CHECK_MS = HOUR
/** Proof of an edge older than this no longer counts. */
const EDGE_STALE_MS = 3 * CHECK_MS
/** A cycle that takes longer than this is abandoned. */
const WORKER_TIMEOUT_MS = 15 * 60_000
/** Heap cap for the worker: running out stops the cycle, never the bot. */
const WORKER_HEAP_MB = 2_048
const MAX_ADOPTIONS_KEPT = 50

export interface Adoption {
  id: number
  at: number
  changes: ParamChange[]
  from: TunableParams
  to: TunableParams
  /** The held-out test result that justified it. */
  test: { trades: number; currentLamports: number; candidateLamports: number }
  status: 'probation' | 'kept' | 'rolled-back' | 'reverted'
  endedAt?: number
  detail?: string
}

export interface CycleSummary {
  at: number
  trigger: 'schedule' | 'manual'
  ms: number
  records: number
  /** `skipped`: no search this cycle (probation, cooldown, or not due yet). */
  decision: TuningResult['decision'] | 'skipped' | 'error'
  reason: string
  changes: ParamChange[]
  gates: Gate[]
  data?: TuningResult['data']
  metrics?: TuningResult['metrics']
  probation?: ProbationResult
}

interface TuningState {
  v: 1
  /** The .env settings the overrides were built on. */
  baseline: TunableParams
  /** The settings in effect. */
  active: TunableParams
  adoptions: Adoption[]
  probation?: { adoptionId: number; since: number; neededTrades: number; last?: ProbationResult }
  /**
   * Live mode: a candidate being paper-tested on launches that arrive after
   * it was found, before any real money trades on it.
   */
  shadow?: {
    since: number
    neededTrades: number
    from: TunableParams
    to: TunableParams
    changes: ParamChange[]
    test: Adoption['test']
    last?: ProbationResult
  }
  cooldownUntil?: number
  cooldownReason?: string
  /** Settings that failed probation, not adopted again for a while. */
  rolledBack: { key: string; at: number }[]
  /** Latest proposal that passed every gate (suggest mode). */
  suggestion?: { at: number; changes: ParamChange[]; gates: Gate[]; metrics?: TuningResult['metrics'] }
  /** Last search, probation verdict or failure (what the report shows). */
  lastRun?: CycleSummary
  lastProposalAt?: number
  lastCheckAt?: number
  /** Whether the settings in effect make money on recent launches. */
  edge?: EdgeResult
}

export interface AutoTunerOptions {
  /** Run cycles on the calling thread (tests). Default: a worker thread. */
  inline?: boolean
  /** Operating cost per day the edge must cover (null: not priced yet). */
  costPerDayLamports?: () => number | null
  /** Delay before the first cycle after start. */
  startDelayMs?: number
  now?: () => number
}

export interface TradingGate {
  allowed: boolean
  reason: string
}

const describe = (changes: ParamChange[]) => changes.map((c) => `${c.env} ${c.from} → ${c.to}`).join(', ')
const iso = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ')

const adoptsIn = (cfg: Config) => (cfg.autotune.mode === 'paper' && cfg.dryRun) || (cfg.autotune.mode === 'live' && !cfg.dryRun)

const stateFile = (cfg: Config) => {
  const name = adoptsIn(cfg) ? (cfg.dryRun ? 'paper' : 'live') : `${cfg.autotune.mode}-${cfg.dryRun ? 'paper' : 'live'}`
  return join(cfg.dataDir, 'tuning', `state-${name}.json`)
}

/**
 * The autotuned settings the bot would run with (paper autotune), so offline
 * tools replay what the bot actually does. Undefined when there are none or
 * the .env settings changed since.
 */
export async function loadTunedParams(cfg: Config): Promise<{ params: TunableParams; changes: ParamChange[] } | undefined> {
  if (!adoptsIn(cfg)) return undefined
  const saved = await readJson<TuningState>(stateFile(cfg)).catch(() => undefined)
  if (!saved || saved.v !== 1) return undefined
  const baseline = paramsFromConfig(cfg)
  if (paramsKey(saved.baseline) !== paramsKey(baseline)) return undefined
  const changes = diffParams(baseline, saved.active)
  return changes.length ? { params: saved.active, changes } : undefined
}

/**
 * Self-tuning, with the brakes on.
 *
 * Every cycle searches recorded launches for nearby entry/filter/exit
 * settings that beat the current ones, and only accepts a candidate that
 * also wins on the most recent launches the search never saw (see
 * `proposeTuning`).
 *
 * - `suggest`: report the candidate; a human decides.
 * - `paper` (paper trading only): adopt it, then keep it on probation. If it
 *   does worse than the settings it replaced on launches that arrive after
 *   the adoption, it is rolled back and tuning pauses for a cooldown.
 *
 * With REQUIRE_EDGE it is also the bot's permission to trade: buying is only
 * allowed while the settings in effect make money on recent launches
 * (`evaluateEdge`). Until then the bot only watches and records.
 *
 * Trade size, reserve, fees and risk limits are never touched. Overrides live
 * in data/tuning and are dropped as soon as the .env settings change.
 */
export class AutoTuner extends EventEmitter<{ notice: ['info' | 'warn' | 'error', string] }> {
  private readonly baseline: TunableParams
  private readonly path: string
  private readonly reportPath: string
  private readonly journal: Journal
  private state: TuningState
  private gate: TradingGate = { allowed: false, reason: 'checking whether the settings make money' }
  private timer?: NodeJS.Timeout
  private worker?: Worker
  private running = false
  private stopped = false
  private started = false
  private nextRunAt?: number
  private version = 0
  private readonly now: () => number

  constructor(
    private readonly cfg: Config,
    private readonly log: Logger,
    private readonly opts: AutoTunerOptions = {},
  ) {
    super()
    // Captured before any override is applied: these are the .env settings.
    this.baseline = paramsFromConfig(cfg)
    this.now = opts.now ?? Date.now
    const dir = join(cfg.dataDir, 'tuning')
    this.path = stateFile(cfg)
    this.reportPath = join(dir, 'report.md')
    this.journal = new Journal(join(dir, 'history.jsonl'), (err) => log.warn({ err }, 'tuning journal write failed'))
    this.state = this.freshState()
  }

  /** True when this tuner may change the running bot's settings. */
  get adopts(): boolean {
    return adoptsIn(this.cfg)
  }

  /** Live autotune: real money, so every candidate is shadow-tested first. */
  get live(): boolean {
    return this.cfg.autotune.mode === 'live' && !this.cfg.dryRun
  }

  /** Share of the normal trade size to use now: reduced while live settings are on probation. */
  sizeFactor(): number {
    return this.live && this.state.probation ? this.cfg.autotune.liveProbationSizePct / 100 : 1
  }

  get busy(): boolean {
    return this.running
  }

  /** Bumped whenever the tuner changes the running settings. */
  get settingsVersion(): number {
    return this.version
  }

  /**
   * May the bot open a position now? Always yes without REQUIRE_EDGE.
   * Called on every entry, so it only reads cached state.
   */
  tradingGate(): TradingGate {
    if (!this.cfg.autotune.requireEdge) return { allowed: true, reason: 'edge not required' }
    if (this.gate.allowed && this.now() - (this.state.edge?.at ?? 0) > EDGE_STALE_MS) {
      return { allowed: false, reason: 'edge check overdue' }
    }
    return this.gate
  }

  /** Restores earlier adoptions (paper mode). Call before trading starts. */
  async load(): Promise<void> {
    const saved = await readJson<TuningState>(this.path)
    if (saved && saved.v === 1) {
      this.state = { ...this.freshState(), ...saved, rolledBack: saved.rolledBack ?? [] }
      if (paramsKey(saved.baseline) !== paramsKey(this.baseline)) {
        // The user changed .env: their settings win, earlier overrides are stale.
        const dropped = diffParams(saved.baseline, saved.active)
        this.endProbation('reverted', '.env settings changed')
        this.state.baseline = this.baseline
        this.state.active = this.baseline
        this.state.cooldownUntil = undefined
        this.state.cooldownReason = undefined
        if (dropped.length) {
          this.log.warn({ dropped: describe(dropped) }, 'autotune: .env settings changed since the last adoption, tuned overrides dropped')
          void this.journal.append({ type: 'reset', at: this.now(), reason: '.env settings changed', dropped })
        }
        await this.persist()
      } else {
        const overrides = diffParams(this.baseline, this.state.active)
        if (overrides.length) {
          this.setActive(this.state.active)
          this.log.info({ overrides: describe(overrides) }, 'autotune: tuned settings restored')
        }
      }
    }
    this.refreshGate(false)
    if (this.cfg.autotune.requireEdge) {
      const g = this.tradingGate()
      this.log.info({ allowed: g.allowed, reason: g.reason }, g.allowed ? 'edge proven: trading enabled' : 'no proven edge yet: watching and recording only')
    }
  }

  start(): void {
    this.stopped = false
    this.started = true
    const interval = this.intervalMs()
    const last = this.state.lastCheckAt ?? this.state.lastRun?.at
    const startDelay = this.opts.startDelayMs ?? 60_000
    const due = last === undefined ? startDelay : last + interval - this.now()
    this.schedule(Math.min(interval, Math.max(startDelay, due)))
    this.log.info(
      {
        mode: this.cfg.autotune.mode,
        adopts: this.adopts,
        requireEdge: this.cfg.autotune.requireEdge,
        everyHours: this.cfg.autotune.intervalMs / HOUR,
        firstRunInSec: Math.round((this.nextRunAt! - this.now()) / 1000),
      },
      'autotune scheduled',
    )
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.started = false
    clearTimeout(this.timer)
    this.timer = undefined
    await this.worker?.terminate()
    await this.journal.flush()
  }

  /**
   * One cycle: check the probation of the last adoption, look for better
   * settings when a search is due (and nothing is on probation or cooling
   * down), and check whether the settings in effect make money.
   */
  async run(trigger: CycleSummary['trigger'] = 'manual'): Promise<CycleSummary> {
    if (this.running) throw new Error('a tuning cycle is already running')
    this.running = true
    const at = this.now()
    const st = this.state
    const o = this.cfg.autotune
    const current = paramsFromConfig(this.cfg)
    const probationAdoption = this.adopts && st.probation ? this.adoption(st.probation.adoptionId) : undefined
    const shadow = this.live && !probationAdoption ? st.shadow : undefined
    const coolingDown = (st.cooldownUntil ?? 0) > at
    // Hourly checks are cheap; the search itself runs every AUTOTUNE_INTERVAL_HOURS,
    // or with every check while data is still short (then it returns at once).
    const searchDue =
      trigger === 'manual' || st.lastRun?.decision === 'insufficient-data' || at - (st.lastProposalAt ?? 0) >= o.intervalMs - 60_000
    const job: TuningJob = {
      cfg: { ...this.cfg, privateKey: undefined, keypairPath: undefined },
      current,
      days: o.days,
      maxLaunches: o.maxLaunches,
      options: {
        minLaunches: o.minLaunches,
        minHours: o.minHours,
        minTrainTrades: o.minTrainTrades,
        minTestTrades: o.minTestTrades,
        minEdgePct: o.minEdgePct,
        // Live: one change at a time, so a loss can be traced to its cause.
        maxChanges: this.live ? 1 : o.maxChanges,
        exclude: this.recentRollbacks(at).map((r) => r.key),
        costPerDayLamports: this.opts.costPerDayLamports?.(),
      },
      propose: o.mode !== 'off' && !probationAdoption && !shadow && !coolingDown && searchDue,
      probation: probationAdoption && st.probation
        ? { adopted: probationAdoption.to, previous: probationAdoption.from, since: st.probation.since, neededTrades: st.probation.neededTrades }
        : shadow
          ? { adopted: shadow.to, previous: shadow.from, since: shadow.since, neededTrades: shadow.neededTrades }
          : undefined,
      edge: o.requireEdge,
      now: at,
    }

    let summary: CycleSummary
    let res: TuningJobResult | undefined
    try {
      // Nothing to check and nothing to search: skip loading the data.
      res = job.propose || job.probation || job.edge ? await this.execute(job) : { records: 0, ms: 0 }
      if (this.stopped) throw new Error('stopped')
      if (paramsKey(paramsFromConfig(this.cfg)) !== paramsKey(current)) {
        summary = { at, trigger, ms: res.ms, records: res.records, decision: 'skipped', reason: 'settings changed while tuning; result discarded', changes: [], gates: [] }
        res = undefined
      } else {
        summary = this.apply(res, job, trigger, coolingDown)
      }
    } catch (err) {
      const message = (err as Error).message
      summary = { at, trigger, ms: this.now() - at, records: 0, decision: 'error', reason: message, changes: [], gates: [] }
      // Shutting down mid-cycle is not a result worth keeping.
      if (this.stopped) return summary
      this.log.error({ err }, 'autotune cycle failed')
      this.notice('error', `autotune cycle failed: ${message}`)
    } finally {
      this.running = false
    }

    st.lastCheckAt = at
    if (res) {
      // The edge result that belongs to the settings now in effect (they may
      // have just changed through an adoption or a rollback).
      const activeKey = paramsKey(paramsFromConfig(this.cfg))
      const edge = [res.edge, res.candidateEdge, res.previousEdge].find((e) => e?.settingsKey === activeKey)
      if (edge) st.edge = edge
    }
    this.refreshGate(true)

    // Routine checks (probation pending, cooldown, search not due) are
    // visible on the dashboard; the report keeps the last real decision.
    const meaningful = summary.decision !== 'skipped' || (summary.probation && summary.probation.status !== 'pending')
    if (meaningful) st.lastRun = summary
    this.log.info(
      {
        trigger,
        decision: summary.decision,
        reason: summary.reason,
        records: summary.records,
        ms: Math.round(summary.ms),
        changes: describe(summary.changes) || undefined,
        edge: o.requireEdge ? this.tradingGate().reason : undefined,
      },
      'autotune cycle',
    )
    await this.persist()
    if (meaningful) await this.writeReport(summary)
    if (!this.stopped && this.timer === undefined && trigger === 'schedule') this.schedule(this.intervalMs())
    // Settings changed without a matching edge check: check them soon (not
    // after a failed cycle, which would retry in a tight loop).
    if (res && o.requireEdge && st.edge?.settingsKey !== paramsKey(paramsFromConfig(this.cfg))) this.checkSoon()
    return summary
  }

  /** Back to the .env settings; tuning pauses for the cooldown. */
  async revert(): Promise<ParamChange[]> {
    if (!this.adopts) throw new Error('nothing to revert: settings are only tuned automatically with AUTOTUNE=paper or live')
    if (this.running) throw new Error('a tuning cycle is running; try again when it finishes')
    const undone = diffParams(this.state.active, this.baseline)
    if (!undone.length && !this.state.probation && !this.state.shadow) return []
    this.state.shadow = undefined
    this.endProbation('reverted', 'reverted by hand')
    this.setActive(this.baseline)
    this.startCooldown('reverted by hand')
    void this.journal.append({ type: 'revert', at: this.now(), undone })
    this.log.warn({ undone: describe(undone) || 'nothing' }, 'autotune: reverted to .env settings')
    if (undone.length) this.notice('warn', `autotune: back to .env settings (${describe(undone)})`)
    // The .env settings need their own proof before the bot trades on them.
    this.refreshGate(true)
    await this.persist()
    this.checkSoon()
    return undone
  }

  status() {
    const st = this.state
    const o = this.cfg.autotune
    const probationAdoption = st.probation ? this.adoption(st.probation.adoptionId) : undefined
    const at = this.now()
    const gate = this.tradingGate()
    const edge = st.edge && st.edge.settingsKey === paramsKey(paramsFromConfig(this.cfg)) ? st.edge : undefined
    return {
      mode: o.mode,
      adopts: this.adopts,
      running: this.running,
      intervalHours: o.intervalMs / HOUR,
      nextRunAt: this.nextRunAt ?? null,
      lastCheckAt: st.lastCheckAt ?? null,
      edge: {
        required: o.requireEdge,
        allowed: gate.allowed,
        reason: gate.reason,
        status: edge?.status ?? 'unknown',
        at: edge?.at ?? null,
        recent: edge?.recent ?? null,
        gates: edge?.gates ?? [],
      },
      overrides: this.adopts ? diffParams(this.baseline, paramsFromConfig(this.cfg)) : [],
      probation:
        st.probation && probationAdoption
          ? {
              since: st.probation.since,
              neededTrades: st.probation.neededTrades,
              trades: st.probation.last?.trades ?? 0,
              detail: st.probation.last?.detail ?? 'waiting for new launches',
              changes: probationAdoption.changes,
            }
          : null,
      shadow: st.shadow
        ? {
            since: st.shadow.since,
            neededTrades: st.shadow.neededTrades,
            trades: st.shadow.last?.trades ?? 0,
            detail: st.shadow.last?.detail ?? 'waiting for new launches',
            changes: st.shadow.changes,
          }
        : null,
      sizeFactor: this.sizeFactor(),
      cooldownUntil: (st.cooldownUntil ?? 0) > at ? st.cooldownUntil! : null,
      cooldownReason: (st.cooldownUntil ?? 0) > at ? (st.cooldownReason ?? null) : null,
      last: st.lastRun ?? null,
      suggestion: this.adopts ? null : (st.suggestion ?? null),
      adoptions: st.adoptions
        .slice(-10)
        .reverse()
        .map(({ id, at, changes, status, endedAt, detail, test }) => ({ id, at, changes, status, endedAt, detail, test })),
      limits: {
        minLaunches: o.minLaunches,
        minHours: o.minHours,
        minTrades: o.minTrainTrades,
        minEdgePct: o.minEdgePct,
        maxChanges: o.maxChanges,
        probationTrades: o.probationTrades,
        cooldownHours: o.cooldownMs / HOUR,
      },
    }
  }

  // Internals ----------------------------------------------------------------

  private freshState(): TuningState {
    return { v: 1, baseline: this.baseline, active: this.baseline, adoptions: [], rolledBack: [] }
  }

  private intervalMs(): number {
    const o = this.cfg.autotune
    const frequent = o.requireEdge || (this.adopts && (this.state.probation || this.state.shadow))
    return frequent ? Math.min(o.intervalMs, CHECK_MS) : o.intervalMs
  }

  private schedule(ms: number): void {
    clearTimeout(this.timer)
    this.nextRunAt = this.now() + ms
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.running) {
        this.schedule(this.intervalMs())
        return
      }
      void this.run('schedule')
    }, ms)
    this.timer.unref()
  }

  /** Runs a check shortly, e.g. after the settings changed. */
  private checkSoon(): void {
    if (this.started && !this.stopped) this.schedule(5_000)
  }

  /**
   * Recomputes the cached trading permission from the last edge check. It
   * only counts for the exact settings that were checked.
   */
  private refreshGate(announce: boolean): void {
    const prev = this.gate
    const e = this.state.edge
    const key = paramsKey(paramsFromConfig(this.cfg))
    this.gate = !e || e.settingsKey !== key
      ? { allowed: false, reason: 'checking whether the settings in effect make money' }
      : { allowed: e.status === 'proven', reason: e.reason }
    if (!announce || !this.cfg.autotune.requireEdge || prev.allowed === this.gate.allowed) return
    void this.journal.append({ type: 'edge', at: this.now(), allowed: this.gate.allowed, reason: this.gate.reason })
    if (this.gate.allowed) {
      this.notice('info', `edge proven, trading enabled: ${this.gate.reason}`)
      this.log.warn({ reason: this.gate.reason }, 'edge proven: trading enabled')
    } else {
      this.notice('warn', `buying paused, still recording: ${this.gate.reason}`)
      this.log.warn({ reason: this.gate.reason }, 'no proven edge: buying paused')
    }
  }

  /** Settings that failed probation within the data window are not tried again. */
  private recentRollbacks(at: number): TuningState['rolledBack'] {
    return this.state.rolledBack.filter((r) => r.at > at - this.cfg.autotune.days * DAY)
  }

  private adoption(id: number): Adoption | undefined {
    return this.state.adoptions.find((a) => a.id === id)
  }

  /** Acts on a finished job: probation verdict first, then the proposal. */
  private apply(res: TuningJobResult, job: TuningJob, trigger: CycleSummary['trigger'], coolingDown: boolean): CycleSummary {
    const st = this.state
    const at = job.now
    const base = { at, trigger, ms: res.ms, records: res.records }

    if (res.probation && st.probation) {
      const pr = res.probation
      const adoption = this.adoption(st.probation.adoptionId)!
      st.probation.last = pr
      if (pr.status === 'passed') {
        this.endProbation('kept', pr.detail)
        void this.journal.append({ type: 'kept', at, adoption: adoption.id, changes: adoption.changes, probation: pr })
        this.notice('info', `autotune: keeping ${describe(adoption.changes)} (${pr.detail})`)
      } else if (pr.status === 'failed') {
        this.endProbation('rolled-back', pr.detail)
        this.setActive(adoption.from)
        st.rolledBack = [...this.recentRollbacks(at), { key: paramsKey(adoption.to), at }]
        this.startCooldown(`rolled back ${describe(adoption.changes)}`)
        void this.journal.append({ type: 'rollback', at, adoption: adoption.id, changes: adoption.changes, probation: pr })
        this.notice('warn', `autotune: rolled back ${describe(adoption.changes)} (${pr.detail})`)
      }
      return { ...base, decision: 'skipped', reason: `probation ${pr.status}: ${pr.detail}`, changes: [], gates: [], probation: pr }
    }

    if (res.probation && st.shadow) {
      const pr = res.probation
      const sh = st.shadow
      sh.last = pr
      if (pr.status === 'passed') {
        st.shadow = undefined
        this.adopt(sh.from, sh.to, sh.changes, sh.test, at, `after a shadow test (${pr.detail})`)
      } else if (pr.status === 'failed') {
        st.shadow = undefined
        st.rolledBack = [...this.recentRollbacks(at), { key: paramsKey(sh.to), at }]
        void this.journal.append({ type: 'shadow-failed', at, changes: sh.changes, probation: pr })
        this.notice('warn', `autotune: shadow test failed, not adopting ${describe(sh.changes)} (${pr.detail})`)
      }
      return { ...base, decision: 'skipped', reason: `shadow test ${pr.status}: ${pr.detail}`, changes: [], gates: [], probation: pr }
    }

    const p = res.proposal
    if (!p) {
      const o = this.cfg.autotune
      const reason =
        o.mode === 'off'
          ? 'autotune off: edge check only'
          : coolingDown
            ? `cooling down until ${iso(st.cooldownUntil ?? at)} (${st.cooldownReason ?? ''})`
            : `next search after ${iso((st.lastProposalAt ?? at) + o.intervalMs)}`
      return { ...base, decision: 'skipped', reason, changes: [], gates: [] }
    }
    st.lastProposalAt = at
    const out: CycleSummary = { ...base, decision: p.decision, reason: p.reason, changes: p.changes, gates: p.gates, data: p.data, metrics: p.metrics }
    void this.journal.append({ type: 'cycle', mode: this.cfg.autotune.mode, ...out })

    if (p.decision !== 'adopt' || !p.candidate) {
      if (p.decision !== 'insufficient-data') st.suggestion = undefined
      return out
    }

    // Belt and braces: never act on a candidate outside the limits.
    const failed = this.recentRollbacks(at).find((r) => r.key === paramsKey(p.candidate!))
    const guard: Gate = failed
      ? { name: 'not rolled back before', pass: false, detail: `these settings failed probation on ${iso(failed.at)}` }
      : !withinLimits(p.candidate, job.current) || p.changes.length > (this.live ? 1 : this.cfg.autotune.maxChanges)
        ? { name: 'within limits', pass: false, detail: 'candidate outside the tuning limits' }
        : { name: 'within limits', pass: true, detail: `${p.changes.length} change(s), all within bounds and step limits` }
    out.gates = [...p.gates, guard]
    if (!guard.pass) {
      out.decision = 'reject'
      out.reason = `failed: ${guard.name}`
      return out
    }
    out.reason = `all ${out.gates.length} gates passed`

    if (!this.adopts) {
      const isNew = !st.suggestion || describe(st.suggestion.changes) !== describe(p.changes)
      st.suggestion = { at, changes: p.changes, gates: out.gates, metrics: p.metrics }
      if (isNew) this.notice('info', `autotune suggests ${describe(p.changes)} (see ${this.reportPath})`)
      return out
    }

    const metrics = p.metrics!
    const test = {
      trades: metrics.candidate?.test.trades ?? 0,
      currentLamports: metrics.current.test.totalPnlLamports,
      candidateLamports: metrics.candidate?.test.totalPnlLamports ?? 0,
    }
    if (this.live) {
      // Real money: first prove it forward on launches nobody has seen yet, without trading it.
      st.shadow = { since: at, neededTrades: this.cfg.autotune.probationTrades, from: job.current, to: p.candidate, changes: p.changes, test }
      void this.journal.append({ type: 'shadow', at, changes: p.changes, test })
      this.notice('info', `autotune: shadow-testing ${describe(p.changes)} on new launches before trading it live (${this.cfg.autotune.probationTrades} trades)`)
      out.reason = `all ${out.gates.length} gates passed; shadow test started`
      if (this.timer) this.schedule(this.intervalMs())
      return out
    }
    this.adopt(job.current, p.candidate, p.changes, test, at, `(test ${sol(test.currentLamports)} → ${sol(test.candidateLamports)} SOL)`)
    return out
  }

  /** Puts adopted settings into effect and on probation. */
  private adopt(from: TunableParams, to: TunableParams, changes: ParamChange[], test: Adoption['test'], at: number, why: string): void {
    const st = this.state
    const adoption: Adoption = { id: (st.adoptions.at(-1)?.id ?? 0) + 1, at, changes, from, to, test, status: 'probation' }
    this.setActive(to)
    st.adoptions = [...st.adoptions, adoption].slice(-MAX_ADOPTIONS_KEPT)
    st.probation = { adoptionId: adoption.id, since: at, neededTrades: this.cfg.autotune.probationTrades }
    void this.journal.append({ type: 'adopt', at, adoption: adoption.id, changes, test, live: this.live })
    const stake = this.live ? `; trading at ${this.cfg.autotune.liveProbationSizePct}% size` : ''
    this.notice('info', `autotune adopted ${describe(changes)} ${why}; on probation for ${this.cfg.autotune.probationTrades} trades${stake}`)
    this.log.warn({ changes: describe(changes), test, live: this.live }, `autotune: adopted new settings (${this.live ? 'LIVE' : 'paper'})`)
    // Probation is checked more often than regular cycles.
    if (this.timer) this.schedule(this.intervalMs())
  }

  /** Puts `p` into effect on the running bot. */
  private setActive(p: TunableParams): void {
    applyParams(this.cfg, p)
    this.state.active = p
    this.version++
  }

  private endProbation(status: Adoption['status'], detail: string): void {
    const st = this.state
    if (!st.probation) return
    const a = this.adoption(st.probation.adoptionId)
    if (a) {
      a.status = status
      a.endedAt = this.now()
      a.detail = detail
    }
    st.probation = undefined
  }

  private startCooldown(reason: string): void {
    this.state.cooldownUntil = this.now() + this.cfg.autotune.cooldownMs
    this.state.cooldownReason = reason
  }

  private execute(job: TuningJob): Promise<TuningJobResult> {
    if (this.opts.inline) return runTuningJob(job)
    return new Promise((resolve, reject) => {
      const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js'
      const worker = new Worker(new URL('./tuning-worker.mjs', import.meta.url), {
        workerData: { module: new URL(`./tuning-job.${ext}`, import.meta.url).href, job },
        resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
      })
      this.worker = worker
      let settled = false
      const done = (err?: Error, value?: TuningJobResult) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        this.worker = undefined
        if (err) reject(err)
        else resolve(value!)
      }
      const timeout = setTimeout(() => {
        void worker.terminate()
        done(new Error(`tuning took longer than ${WORKER_TIMEOUT_MS / 60_000} minutes; lower AUTOTUNE_DAYS or AUTOTUNE_MAX_LAUNCHES`))
      }, WORKER_TIMEOUT_MS)
      worker.once('message', (value: TuningJobResult) => {
        done(undefined, value)
        void worker.terminate()
      })
      worker.once('error', (err: NodeJS.ErrnoException) =>
        done(err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? new Error('tuning ran out of memory; lower AUTOTUNE_MAX_LAUNCHES') : err),
      )
      worker.once('exit', (code) => done(new Error(`tuning worker exited with code ${code}`)))
    })
  }

  private async persist(): Promise<void> {
    try {
      await writeJsonAtomic(this.path, this.state)
    } catch (err) {
      this.log.warn({ err }, 'autotune state write failed')
    }
  }

  private notice(level: 'info' | 'warn' | 'error', message: string): void {
    this.emit('notice', level, message)
  }

  private async writeReport(s: CycleSummary): Promise<void> {
    const st = this.state
    const lines: string[] = [
      '# Autotune report',
      '',
      `Generated ${new Date(s.at).toISOString()} (${s.trigger}). Mode: **${this.cfg.autotune.mode}**${this.live ? ' (adopts in LIVE trading after a shadow test, at reduced size during probation)' : this.adopts ? ' (adopts automatically, paper only)' : ' (proposes only)'}.`,
      '',
    ]
    if (this.cfg.autotune.requireEdge) {
      const g = this.tradingGate()
      lines.push(`**Trading: ${g.allowed ? 'enabled' : 'paused, recording only'}.** ${g.reason}.`, '')
    }
    lines.push(`## Decision: ${s.decision.toUpperCase()}`, '', s.reason, '')
    if (s.data) {
      lines.push(`Data: ${s.data.launches} launches over ${s.data.hours.toFixed(1)}h; searched on the oldest ${s.data.trainLaunches}, validated on the newest ${s.data.testLaunches}.`, '')
    }
    if (s.changes.length) {
      lines.push('## Changes', '', table(['Setting', 'Current', 'Proposed'], s.changes.map((c) => [c.env, c.from, c.to])), '')
    }
    if (s.metrics) {
      const rows = [summaryRow('Current (train)', s.metrics.current.train), summaryRow('Current (test)', s.metrics.current.test)]
      if (s.metrics.candidate) rows.push(summaryRow('Proposed (train)', s.metrics.candidate.train), summaryRow('Proposed (test)', s.metrics.candidate.test))
      lines.push('## Simulated results', '', table(SUMMARY_HEADERS, rows), '')
    }
    if (s.gates.length) {
      lines.push('## Gates', '', table(['Gate', 'Result', 'Detail'], s.gates.map((g) => [g.name, g.pass ? 'pass' : 'FAIL', g.detail])), '')
    }
    if (st.shadow) {
      lines.push('## Shadow test', '', `${describe(st.shadow.changes)} since ${iso(st.shadow.since)}, not traded yet: ${st.shadow.last?.detail ?? 'waiting for new launches'}.`, '')
    }
    if (st.probation) {
      const a = this.adoption(st.probation.adoptionId)
      lines.push('## Probation', '', `${a ? describe(a.changes) : ''} since ${iso(st.probation.since)}: ${st.probation.last?.detail ?? 'waiting for new launches'}.`, '')
    }
    const overrides = diffParams(this.baseline, paramsFromConfig(this.cfg))
    lines.push('## Settings in effect', '')
    if (overrides.length) {
      lines.push('Tuned (differs from .env):', '', table(['Setting', '.env', 'In effect'], overrides.map((c) => [c.env, c.from, c.to])), '')
    } else {
      lines.push('Exactly the .env settings.', '')
    }
    const suggestion = !this.adopts && st.suggestion ? st.suggestion.changes : undefined
    if (suggestion?.length) {
      lines.push('To adopt the suggestion, set these in .env and restart:', '', '```env', ...suggestion.map((c) => `${c.env}=${c.to}`), '```', '')
    } else if (overrides.length) {
      lines.push('To keep these settings permanently (or use them live), put them in .env:', '', '```env', ...overrides.map((c) => `${c.env}=${c.to}`), '```', '')
    }
    try {
      await mkdir(join(this.cfg.dataDir, 'tuning'), { recursive: true })
      await writeFile(this.reportPath, lines.join('\n'))
    } catch (err) {
      this.log.warn({ err }, 'autotune report write failed')
    }
  }
}
