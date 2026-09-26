import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Config } from '../config.js'
import type { LaunchRecord } from './record.js'
import { type Summary, replayConfigFrom, summarizeResults } from './replay.js'
import type { StrategySearchResult } from './search.js'
import { type ParamChange, type TunableParams, completeParams, paramsFromConfig } from './tunable.js'
import { Evaluator } from './tuner.js'

/**
 * Forward testing without trading: candidates are frozen with the moment
 * their data ended, and later judged only on launches recorded after that.
 * The replay matches the bot's own trades closely, so this is a paper test
 * of every candidate at once, and just as honest: none of them could have
 * been fitted to data that did not exist yet.
 */

export interface FrozenCandidate {
  label: string
  params: TunableParams
  /** Versus the settings in effect when frozen. */
  changes: ParamChange[]
  /** What the research saw, for reference. */
  research?: { validation?: Summary; test?: Summary }
}

export interface CandidateSet {
  v: 1
  createdAt: number
  /** Last launch the candidates could have been fitted to: only later ones count. */
  frozenAt: number
  source: string
  verdict?: string
  /** Trade size, latency and network fees at the time: results assume the same. */
  context: { buySol: number; latencyMs: number; roundTripNetworkSol: number }
  candidates: FrozenCandidate[]
}

export type ForwardVerdict = 'pass' | 'fail' | 'pending'

export interface ForwardResult {
  label: string
  /** Versus the settings in effect when the set was frozen. */
  changes: ParamChange[]
  summary: Summary
  /** Total without the single best trade. */
  withoutBestLamports: number
  verdict: ForwardVerdict
  detail: string
}

const contextOf = (cfg: Config): CandidateSet['context'] => {
  const rc = replayConfigFrom(cfg)
  return { buySol: rc.buyLamports / 1e9, latencyMs: rc.latencyMs, roundTripNetworkSol: (rc.buyNetworkLamports + rc.sellNetworkLamports) / 1e9 }
}

/** The settings in effect and every research finalist, frozen at the end of the research data. */
export function candidateSetFromResearch(r: StrategySearchResult, cfg: Config, records: LaunchRecord[], now = Date.now()): CandidateSet {
  const current = paramsFromConfig(cfg)
  const frozenAt = records.reduce((m, rec) => Math.max(m, rec.t), 0)
  const bestKey = r.best ? JSON.stringify(r.best.params) : undefined
  return {
    v: 1,
    createdAt: now,
    frozenAt,
    source: 'research',
    verdict: r.decision,
    context: contextOf(cfg),
    candidates: [
      { label: 'current settings', params: current, changes: [], research: r.current ? { validation: r.current.validation, test: r.current.test } : undefined },
      ...r.finalists.map((f, i) => ({
        label: `finalist ${i + 1}${JSON.stringify(f.params) === bestKey ? ' (best)' : ''}`,
        params: f.params,
        changes: f.changes,
        research: { validation: f.validation, test: JSON.stringify(f.params) === bestKey ? r.best!.test : undefined },
      })),
    ],
  }
}

const stamp = (t: number) => new Date(t).toISOString().slice(0, 16).replace(':', '')

export async function saveCandidates(dataDir: string, set: CandidateSet): Promise<string> {
  const dir = join(dataDir, 'candidates')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${set.source}-${stamp(set.createdAt)}.json`)
  await writeFile(path, JSON.stringify(set, null, 2))
  return path
}

/** Saved candidate sets, newest first. */
export async function loadCandidateSets(dataDir: string): Promise<{ file: string; set: CandidateSet }[]> {
  const dir = join(dataDir, 'candidates')
  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  const out: { file: string; set: CandidateSet }[] = []
  for (const file of files) {
    try {
      const set = JSON.parse(await readFile(join(dir, file), 'utf8')) as CandidateSet
      if (set.v === 1 && Array.isArray(set.candidates)) out.push({ file, set })
    } catch {
      // Not ours, or damaged: skip it.
    }
  }
  return out.sort((a, b) => b.set.createdAt - a.set.createdAt)
}

/**
 * Replays every candidate of `set` on the launches recorded after it was
 * frozen, and judges it on what was agreed up front: at least `minTrades`
 * trades, a positive total, and still positive without the best trade.
 */
export function forwardTest(records: LaunchRecord[], cfg: Config, set: CandidateSet, minTrades: number): { launches: number; results: ForwardResult[] } {
  const fresh = records.filter((r) => r.t > set.frozenAt)
  const e = new Evaluator(fresh, cfg)
  const base = paramsFromConfig(cfg)
  const results = set.candidates.map((c): ForwardResult => {
    const params = completeParams(c.params, base)
    const outcomes = e.results(params)
    const summary = summarizeResults(outcomes)
    const bestWin = outcomes.reduce((m, o) => Math.max(m, o.pnlLamports), 0)
    const withoutBestLamports = summary.totalPnlLamports - bestWin
    const sol = (l: number) => `${(l / 1e9).toFixed(4)} SOL`
    if (summary.trades < minTrades) {
      return { label: c.label, changes: c.changes, summary, withoutBestLamports, verdict: 'pending', detail: `${summary.trades}/${minTrades} trades so far` }
    }
    const pass = summary.totalPnlLamports > 0 && withoutBestLamports > 0
    return {
      label: c.label,
      changes: c.changes,
      summary,
      withoutBestLamports,
      verdict: pass ? 'pass' : 'fail',
      detail: `${sol(summary.totalPnlLamports)} over ${summary.trades} trades, ${sol(withoutBestLamports)} without the best one`,
    }
  })
  return { launches: fresh.length, results }
}

/** Differences between the conditions a set was frozen under and today's .env (results assume the same). */
export function contextChanges(set: CandidateSet, cfg: Config): string[] {
  const now = contextOf(cfg)
  const out: string[] = []
  if (Math.abs(now.buySol - set.context.buySol) > 1e-9) out.push(`trade size ${set.context.buySol} → ${now.buySol} SOL`)
  if (now.latencyMs !== set.context.latencyMs) out.push(`latency ${set.context.latencyMs} → ${now.latencyMs} ms`)
  if (Math.abs(now.roundTripNetworkSol - set.context.roundTripNetworkSol) > 1e-9) {
    out.push(`network fees per round trip ${set.context.roundTripNetworkSol.toFixed(5)} → ${now.roundTripNetworkSol.toFixed(5)} SOL`)
  }
  return out
}
