import type { Config } from '../config.js'
import { loadSample } from './dataset.js'
import { type StrategySearchResult, searchStrategies } from './search.js'
import { type TunableParams, paramsKey } from './tunable.js'
import {
  type EdgeResult,
  type ProbationResult,
  type TunerOptions,
  type TuningResult,
  evaluateEdge,
  evaluateProbation,
  proposeTuning,
} from './tuner.js'

export interface TuningJob {
  cfg: Config
  current: TunableParams
  days: number
  maxLaunches: number
  options: TunerOptions
  propose: boolean
  probation?: { adopted: TunableParams; previous: TunableParams; since: number; neededTrades: number }
  /** Check whether the settings in effect make money (edge gate). */
  edge: boolean
  /** Launches since then count as forward data for the settings in effect (a shadow-tested candidate). */
  currentSince?: number
  /**
   * With the edge gate: settings still collecting their forward proof are not
   * replaced (no search), or their clock would restart with every adoption
   * and the gate might never open. The search resumes once they have a
   * verdict, proven or unproven.
   */
  waitForVerdict?: boolean
  /**
   * While the bot is not trading: if the nearby search finds nothing to
   * adopt, search the whole bounded space (see `searchStrategies`).
   */
  explore?: { budgetMs: number }
  now: number
}

export interface TuningJobResult {
  records: number
  probation?: ProbationResult
  proposal?: TuningResult
  /** Edge of the settings in effect. */
  edge?: EdgeResult
  /** No search: the settings in effect are still collecting their forward proof. */
  collecting?: boolean
  exploration?: StrategySearchResult
  /** Edge of the adopted candidate, for when the proposal (or exploration) is adopted. */
  candidateEdge?: EdgeResult
  /** Edge of the previous settings, for when probation fails and they come back. */
  previousEdge?: EdgeResult
  ms: number
}

/**
 * One tuning cycle's heavy lifting: load recorded launches, check the
 * probation of the last adoption, search for better settings, and check
 * whether the settings make money. Runs in a worker thread so the trading
 * loop never waits on it.
 */
export async function runTuningJob(job: TuningJob): Promise<TuningJobResult> {
  const started = performance.now()
  const { records, stride } = await loadSample(job.cfg.dataDir, { days: job.days, max: job.maxLaunches })
  const out: TuningJobResult = { records: records.length, ms: 0 }
  const edge = (p: TunableParams, since?: number) => evaluateEdge(records, job.cfg, p, { ...job.options, sampleStride: stride }, job.now, since)
  if (job.probation) {
    const p = job.probation
    out.probation = evaluateProbation(records, job.cfg, p.adopted, p.previous, p.since, p.neededTrades)
    if (job.edge && out.probation.status === 'failed') out.previousEdge = edge(p.previous)
    // A shadow-tested candidate that passes goes live right away: it needs its own proof,
    // from the launches since it was picked (recorded under the settings it would replace).
    if (job.edge && out.probation.status === 'passed' && paramsKey(p.adopted) !== paramsKey(job.current)) out.candidateEdge = edge(p.adopted, p.since)
  }
  if (job.edge) out.edge = edge(job.current, job.currentSince)
  out.collecting = job.waitForVerdict === true && out.edge?.status === 'insufficient-data'
  if (job.propose && !out.collecting) {
    out.proposal = proposeTuning(records, job.cfg, job.current, job.options, job.now)
    if (job.edge && out.proposal.decision === 'adopt' && out.proposal.candidate) out.candidateEdge = edge(out.proposal.candidate)
    const nearbyFailed = out.proposal.decision === 'reject' || out.proposal.decision === 'no-improvement'
    if (job.explore && nearbyFailed) {
      const o = job.options
      out.exploration = searchStrategies(
        records,
        job.cfg,
        job.current,
        { minLaunches: o.minLaunches, minHours: o.minHours, minTrades: o.minTrainTrades, minEdgePct: o.minEdgePct, budgetMs: job.explore.budgetMs, exclude: o.exclude },
        job.now,
      )
      if (job.edge && out.exploration.decision === 'found' && out.exploration.best) out.candidateEdge = edge(out.exploration.best.params)
    }
  }
  out.ms = performance.now() - started
  return out
}
