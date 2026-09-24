import type { Config } from '../config.js'
import { loadSample } from './dataset.js'
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
  now: number
}

export interface TuningJobResult {
  records: number
  probation?: ProbationResult
  proposal?: TuningResult
  /** Edge of the settings in effect. */
  edge?: EdgeResult
  /** Edge of the adopted candidate, for when the proposal is adopted. */
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
  const edge = (p: TunableParams) => evaluateEdge(records, job.cfg, p, { ...job.options, sampleStride: stride }, job.now)
  if (job.probation) {
    const p = job.probation
    out.probation = evaluateProbation(records, job.cfg, p.adopted, p.previous, p.since, p.neededTrades)
    if (job.edge && out.probation.status === 'failed') out.previousEdge = edge(p.previous)
    // A shadow-tested candidate that passes goes live right away: it needs its own proof.
    if (job.edge && out.probation.status === 'passed' && paramsKey(p.adopted) !== paramsKey(job.current)) out.candidateEdge = edge(p.adopted)
  }
  if (job.propose) {
    out.proposal = proposeTuning(records, job.cfg, job.current, job.options, job.now)
    if (job.edge && out.proposal.decision === 'adopt' && out.proposal.candidate) out.candidateEdge = edge(out.proposal.candidate)
  }
  if (job.edge) out.edge = edge(job.current)
  out.ms = performance.now() - started
  return out
}
