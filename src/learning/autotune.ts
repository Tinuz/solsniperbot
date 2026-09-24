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
import type { Gate, ProbationResult, TuningResult } from './tuner.js'
import { type TuningJob, type TuningJobResult, runTuningJob } from './tuning-job.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** While settings are on probation they are checked at least this often. */
const PROBATION_CHECK_MS = HOUR
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
  /** `skipped`: no search this cycle (probation or cooldown). */
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
  cooldownUntil?: number
  cooldownReason?: string
  /** Settings that failed probation, not adopted again for a while. */
  rolledBack: { key: string; at: number }[]
  /** Latest proposal that passed every gate (suggest mode). */
  suggestion?: { at: number; changes: ParamChange[]; gates: Gate[]; metrics?: TuningResult['metrics'] }
  lastRun?: CycleSummary
}

export interface AutoTunerOptions {
  /** Run cycles on the calling thread (tests). Default: a worker thread. */
  inline?: boolean
  /** Delay before the first cycle after start. */
  startDelayMs?: number
  now?: () => number
}

const describe = (changes: ParamChange[]) => changes.map((c) => `${c.env} ${c.from} → ${c.to}`).join(', ')
const iso = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ')

/**
 * Self-tuning, with the brakes on.
 *
 * Every cycle searches recorded launches for nearby filter/exit settings that
 * beat the current ones, and only accepts a candidate that also wins on the
 * most recent launches the search never saw (see `proposeTuning`).
 *
 * - `suggest`: report the candidate; a human decides.
 * - `paper` (paper trading only): adopt it, then keep it on probation. If it
 *   does worse than the settings it replaced on launches that arrive after
 *   the adoption, it is rolled back and tuning pauses for a cooldown.
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
  private timer?: NodeJS.Timeout
  private worker?: Worker
  private running = false
  private stopped = false
  private nextRunAt?: number
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
    const name = this.adopts ? 'paper' : `suggest-${cfg.dryRun ? 'paper' : 'live'}`
    this.path = join(dir, `state-${name}.json`)
    this.reportPath = join(dir, 'report.md')
    this.journal = new Journal(join(dir, 'history.jsonl'), (err) => log.warn({ err }, 'tuning journal write failed'))
    this.state = this.freshState()
  }

  /** True when this tuner may change the running bot's settings. */
  get adopts(): boolean {
    return this.cfg.autotune.mode === 'paper' && this.cfg.dryRun
  }

  get busy(): boolean {
    return this.running
  }

  /** Restores earlier adoptions (paper mode). Call before trading starts. */
  async load(): Promise<void> {
    const saved = await readJson<TuningState>(this.path)
    if (!saved || saved.v !== 1) return
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
      return
    }
    const overrides = diffParams(this.baseline, this.state.active)
    if (overrides.length) {
      applyParams(this.cfg, this.state.active)
      this.log.info({ overrides: describe(overrides) }, 'autotune: tuned settings restored')
    }
  }

  start(): void {
    this.stopped = false
    const interval = this.intervalMs()
    const last = this.state.lastRun?.at
    const startDelay = this.opts.startDelayMs ?? 60_000
    const due = last === undefined ? startDelay : last + interval - this.now()
    this.schedule(Math.min(interval, Math.max(startDelay, due)))
    this.log.info(
      { mode: this.cfg.autotune.mode, adopts: this.adopts, everyHours: this.cfg.autotune.intervalMs / HOUR, firstRunInSec: Math.round((this.nextRunAt! - this.now()) / 1000) },
      'autotune scheduled',
    )
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
    this.timer = undefined
    await this.worker?.terminate()
    await this.journal.flush()
  }

  /**
   * One cycle: check the probation of the last adoption, then (if nothing is
   * on probation or cooling down) look for better settings.
   */
  async run(trigger: CycleSummary['trigger'] = 'manual'): Promise<CycleSummary> {
    if (this.running) throw new Error('a tuning cycle is already running')
    this.running = true
    const at = this.now()
    const st = this.state
    const o = this.cfg.autotune
    const current = paramsFromConfig(this.cfg)
    const probationAdoption = this.adopts && st.probation ? this.adoption(st.probation.adoptionId) : undefined
    const coolingDown = (st.cooldownUntil ?? 0) > at
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
        maxChanges: o.maxChanges,
        exclude: this.recentRollbacks(at).map((r) => r.key),
      },
      propose: !probationAdoption && !coolingDown,
      probation: probationAdoption && st.probation
        ? { adopted: probationAdoption.to, previous: probationAdoption.from, since: st.probation.since, neededTrades: st.probation.neededTrades }
        : undefined,
      now: at,
    }

    let summary: CycleSummary
    try {
      // Nothing to check and nothing to search: skip loading the data.
      const res = job.propose || job.probation ? await this.execute(job) : { records: 0, ms: 0 }
      if (this.stopped) throw new Error('stopped')
      if (paramsKey(paramsFromConfig(this.cfg)) !== paramsKey(current)) {
        summary = { at, trigger, ms: res.ms, records: res.records, decision: 'skipped', reason: 'settings changed while tuning; result discarded', changes: [], gates: [] }
      } else {
        summary = this.apply(res, job, trigger)
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

    st.lastRun = summary
    this.log.info(
      { trigger, decision: summary.decision, reason: summary.reason, records: summary.records, ms: Math.round(summary.ms), changes: describe(summary.changes) || undefined },
      'autotune cycle',
    )
    await this.persist()
    // Keep the report on the last real decision; routine skips (probation
    // pending, cooldown) are visible on the dashboard.
    const verdict = summary.probation && summary.probation.status !== 'pending'
    if (summary.decision !== 'skipped' || verdict) await this.writeReport(summary)
    if (!this.stopped && this.timer === undefined && trigger === 'schedule') this.schedule(this.intervalMs())
    return summary
  }

  /** Back to the .env settings; tuning pauses for the cooldown. */
  async revert(): Promise<ParamChange[]> {
    if (!this.adopts) throw new Error('nothing to revert: settings are only tuned automatically in paper mode')
    if (this.running) throw new Error('a tuning cycle is running; try again when it finishes')
    const undone = diffParams(this.state.active, this.baseline)
    if (!undone.length && !this.state.probation) return []
    this.endProbation('reverted', 'reverted by hand')
    applyParams(this.cfg, this.baseline)
    this.state.active = this.baseline
    this.startCooldown('reverted by hand')
    void this.journal.append({ type: 'revert', at: this.now(), undone })
    this.log.warn({ undone: describe(undone) || 'nothing' }, 'autotune: reverted to .env settings')
    if (undone.length) this.notice('warn', `autotune: back to .env settings (${describe(undone)})`)
    await this.persist()
    return undone
  }

  status() {
    const st = this.state
    const o = this.cfg.autotune
    const probationAdoption = st.probation ? this.adoption(st.probation.adoptionId) : undefined
    const at = this.now()
    return {
      mode: o.mode,
      adopts: this.adopts,
      running: this.running,
      intervalHours: o.intervalMs / HOUR,
      nextRunAt: this.nextRunAt ?? null,
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
    return this.adopts && this.state.probation ? Math.min(o.intervalMs, PROBATION_CHECK_MS) : o.intervalMs
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

  /** Settings that failed probation within the data window are not tried again. */
  private recentRollbacks(at: number): TuningState['rolledBack'] {
    return this.state.rolledBack.filter((r) => r.at > at - this.cfg.autotune.days * DAY)
  }

  private adoption(id: number): Adoption | undefined {
    return this.state.adoptions.find((a) => a.id === id)
  }

  /** Acts on a finished job: probation verdict first, then the proposal. */
  private apply(res: TuningJobResult, job: TuningJob, trigger: CycleSummary['trigger']): CycleSummary {
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
        applyParams(this.cfg, adoption.from)
        st.active = adoption.from
        st.rolledBack = [...this.recentRollbacks(at), { key: paramsKey(adoption.to), at }]
        this.startCooldown(`rolled back ${describe(adoption.changes)}`)
        void this.journal.append({ type: 'rollback', at, adoption: adoption.id, changes: adoption.changes, probation: pr })
        this.notice('warn', `autotune: rolled back ${describe(adoption.changes)} (${pr.detail})`)
      }
      return { ...base, decision: 'skipped', reason: `probation ${pr.status}: ${pr.detail}`, changes: [], gates: [], probation: pr }
    }

    const p = res.proposal
    if (!p) {
      return { ...base, decision: 'skipped', reason: `cooling down until ${iso(st.cooldownUntil ?? at)} (${st.cooldownReason ?? ''})`, changes: [], gates: [] }
    }
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
      : !withinLimits(p.candidate, job.current) || p.changes.length > this.cfg.autotune.maxChanges
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

    const test = p.metrics!
    const adoption: Adoption = {
      id: (st.adoptions.at(-1)?.id ?? 0) + 1,
      at,
      changes: p.changes,
      from: job.current,
      to: p.candidate,
      test: {
        trades: test.candidate?.test.trades ?? 0,
        currentLamports: test.current.test.totalPnlLamports,
        candidateLamports: test.candidate?.test.totalPnlLamports ?? 0,
      },
      status: 'probation',
    }
    applyParams(this.cfg, p.candidate)
    st.active = p.candidate
    st.adoptions = [...st.adoptions, adoption].slice(-MAX_ADOPTIONS_KEPT)
    st.probation = { adoptionId: adoption.id, since: at, neededTrades: this.cfg.autotune.probationTrades }
    void this.journal.append({ type: 'adopt', at, adoption: adoption.id, changes: p.changes, test: adoption.test })
    this.notice(
      'info',
      `autotune adopted ${describe(p.changes)} (test ${sol(adoption.test.currentLamports)} → ${sol(adoption.test.candidateLamports)} SOL); on probation for ${this.cfg.autotune.probationTrades} trades`,
    )
    this.log.warn({ changes: describe(p.changes), test: adoption.test }, 'autotune: adopted new settings (paper)')
    // Probation is checked more often than regular cycles.
    if (this.timer) this.schedule(this.intervalMs())
    return out
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
      `Generated ${new Date(s.at).toISOString()} (${s.trigger}). Mode: **${this.cfg.autotune.mode}**${this.adopts ? ' (adopts automatically, paper only)' : ' (proposes only)'}.`,
      '',
      `## Decision: ${s.decision.toUpperCase()}`,
      '',
      s.reason,
      '',
    ]
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
