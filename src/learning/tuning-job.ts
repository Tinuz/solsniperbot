import type { Config } from '../config.js'
import { loadRecords } from './dataset.js'
import type { TunableParams } from './tunable.js'
import { type ProbationResult, type TunerOptions, type TuningResult, evaluateProbation, proposeTuning } from './tuner.js'

export interface TuningJob {
  cfg: Config
  current: TunableParams
  days: number
  maxLaunches: number
  options: TunerOptions
  propose: boolean
  probation?: { adopted: TunableParams; previous: TunableParams; since: number; neededTrades: number }
  now: number
}

export interface TuningJobResult {
  records: number
  probation?: ProbationResult
  proposal?: TuningResult
  ms: number
}

/**
 * One tuning cycle's heavy lifting: load recorded launches, check the
 * probation of the last adoption, and search for better settings. Runs in a
 * worker thread so the trading loop never waits on it.
 */
export async function runTuningJob(job: TuningJob): Promise<TuningJobResult> {
  const started = performance.now()
  const records = await loadRecords(job.cfg.dataDir, { days: job.days, max: job.maxLaunches })
  const out: TuningJobResult = { records: records.length, ms: 0 }
  if (job.probation) {
    const p = job.probation
    out.probation = evaluateProbation(records, job.cfg, p.adopted, p.previous, p.since, p.neededTrades)
  }
  if (job.propose) out.proposal = proposeTuning(records, job.cfg, job.current, job.options, job.now)
  out.ms = performance.now() - started
  return out
}
