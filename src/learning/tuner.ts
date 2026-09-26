import type { Config } from '../config.js'
import type { Launch } from '../feed/market.js'
import { type FilterContext, staticFilter } from '../strategy/filters.js'
import { LruCache } from '../util/lru.js'
import { launchFromRecord, splitByTime } from './dataset.js'
import type { LaunchRecord } from './record.js'
import { type ReplayResult, type Summary, replayConfigFrom, replayLaunch, summarizeResults } from './replay.js'
import {
  type ParamChange,
  type TunableParams,
  diffParams,
  filterKey,
  neighbors,
  paramsKey,
  replayKey,
  settingsFingerprint,
  withParams,
  withinLimits,
} from './tunable.js'

export interface TunerOptions {
  minLaunches: number
  minHours: number
  /** Minimum simulated trades in the training part. */
  minTrainTrades: number
  /** Minimum simulated trades in the held-out test part. */
  minTestTrades: number
  /** Required out-of-sample improvement per test trade, as % of the trade size. */
  minEdgePct: number
  /** Most settings one adoption may change. */
  maxChanges: number
  /** Test part of the data (most recent), 0-1. */
  testFrac?: number
  /** Settings (`paramsKey`) never to propose, e.g. ones that failed probation. */
  exclude?: string[]
  /** Operating cost the edge must cover, per day; null when it cannot be priced yet. */
  costPerDayLamports?: number | null
  /** Recorded launches per loaded one, when the data was sampled. */
  sampleStride?: number
}

export interface Gate {
  name: string
  pass: boolean
  detail: string
}

export interface TuningResult {
  at: number
  decision: 'adopt' | 'reject' | 'insufficient-data' | 'no-improvement'
  reason: string
  current: TunableParams
  candidate?: TunableParams
  changes: ParamChange[]
  data: { launches: number; hours: number; trainLaunches: number; testLaunches: number }
  metrics?: { current: { train: Summary; test: Summary }; candidate?: { train: Summary; test: Summary } }
  gates: Gate[]
}

/** The part of a replay the tuner needs, kept small: many are cached. */
export type Outcome = Pick<ReplayResult, 'entered' | 'entryMs' | 'holdMs' | 'slotMs' | 'pnlLamports' | 'pnlPct'>
const NOT_ENTERED: Outcome = { entered: false, holdMs: 0, slotMs: 0, pnlLamports: 0, pnlPct: 0 }
const outcome = (r: ReplayResult): Outcome =>
  r.entered ? { entered: true, entryMs: r.entryMs, holdMs: r.holdMs, slotMs: r.slotMs, pnlLamports: r.pnlLamports, pnlPct: r.pnlPct } : NOT_ENTERED

interface Row {
  rec: LaunchRecord
  launch: Launch
  ctx: FilterContext
}

const sol = (lamports: number) => `${(lamports / 1e9).toFixed(4)} SOL`

/**
 * Evaluates settings on a fixed set of launches, caching the expensive part:
 * replays depend only on entry and exits, filter verdicts only on filters. The search
 * mostly revisits the best settings so far, so small caches suffice.
 */
export class Evaluator {
  private readonly rows: Row[]
  private readonly replays = new LruCache<string, Outcome[]>(6)
  private readonly masks = new LruCache<string, boolean[]>(12)

  constructor(
    records: LaunchRecord[],
    private readonly cfg: Config,
  ) {
    this.rows = records.map((rec) => ({
      rec,
      launch: launchFromRecord(rec),
      ctx: { initialRealTokenReserves: BigInt(rec.initialRt), creatorLaunches: rec.creatorLaunches },
    }))
  }

  get size(): number {
    return this.rows.length
  }

  /**
   * Trades the settings would have made, in time order, respecting
   * MAX_OPEN_POSITIONS: a launch arriving while every slot is taken is skipped,
   * as it would be live. A moonbag frees its slot when it starts riding
   * (MAX_MOONBAGS is not modelled: at its default it is rarely reached).
   */
  results(p: TunableParams): Outcome[] {
    const c = withParams(this.cfg, p)
    const replays = this.replays.getOrCreate(replayKey(p), () => {
      const rc = replayConfigFrom(c)
      return this.rows.map((r) => outcome(replayLaunch(r.rec, rc)))
    })
    const mask = this.masks.getOrCreate(filterKey(p), () => this.rows.map((r) => staticFilter(r.launch, c.filters, r.ctx).pass))
    const maxOpen = this.cfg.risk.maxOpenPositions
    const openUntil: number[] = []
    const out: Outcome[] = []
    for (let i = 0; i < this.rows.length; i++) {
      const res = replays[i]!
      if (!mask[i] || !res.entered) continue
      const start = this.rows[i]!.rec.t + (res.entryMs ?? 0)
      for (let j = openUntil.length - 1; j >= 0; j--) if (openUntil[j]! <= start) openUntil.splice(j, 1)
      if (openUntil.length >= maxOpen) continue
      openUntil.push(start + res.slotMs)
      out.push(res)
    }
    return out
  }

  summary(p: TunableParams): Summary {
    return summarizeResults(this.results(p))
  }
}

/**
 * Proposes new settings from recorded launches, or explains why not.
 *
 * Search: coordinate descent around the current settings on the older part
 * of the data, one group of settings at a time, never leaving the absolute
 * bounds or one step from the current values, and changing at most
 * `maxChanges` settings.
 *
 * Adoption requires every gate to pass on the most recent part of the data,
 * which the search never saw.
 */
export function proposeTuning(records: LaunchRecord[], cfg: Config, current: TunableParams, o: TunerOptions, now = Date.now()): TuningResult {
  const sorted = [...records].sort((a, b) => a.t - b.t)
  const hours = sorted.length ? (sorted[sorted.length - 1]!.t - sorted[0]!.t) / 3_600_000 : 0
  const { train, test } = splitByTime(sorted, o.testFrac ?? 0.3)
  const base: Omit<TuningResult, 'decision' | 'reason'> = {
    at: now,
    current,
    changes: [],
    data: { launches: sorted.length, hours, trainLaunches: train.length, testLaunches: test.length },
    gates: [],
  }

  const dataGate: Gate = {
    name: 'enough data',
    pass: sorted.length >= o.minLaunches && hours >= o.minHours,
    detail: `${sorted.length} launches over ${hours.toFixed(1)}h (need ${o.minLaunches} over ${o.minHours}h)`,
  }
  if (!dataGate.pass) return { ...base, gates: [dataGate], decision: 'insufficient-data', reason: dataGate.detail }

  const trainEval = new Evaluator(train, cfg)
  const testEval = new Evaluator(test, cfg)
  const curTrain = trainEval.summary(current)
  const curTest = testEval.summary(current)
  const metrics: NonNullable<TuningResult['metrics']> = { current: { train: curTrain, test: curTest } }

  // Search on training data only.
  const score = (s: Summary) => (s.trades >= o.minTrainTrades ? s.totalPnlLamports : Number.NEGATIVE_INFINITY)
  let best = current
  let bestScore = score(trainEval.summary(current))
  const seen = new Set([paramsKey(current), ...(o.exclude ?? [])])
  for (let round = 0; round < 2; round++) {
    for (const { params } of neighbors(best)) {
      const key = paramsKey(params)
      if (seen.has(key)) continue
      seen.add(key)
      if (!withinLimits(params, current)) continue
      if (diffParams(current, params).length > o.maxChanges) continue
      const s = score(trainEval.summary(params))
      if (s > bestScore) {
        best = params
        bestScore = s
      }
    }
  }

  const changes = diffParams(current, best)
  if (changes.length === 0) {
    return { ...base, gates: [dataGate], metrics, decision: 'no-improvement', reason: 'no nearby settings beat the current ones on the training data' }
  }

  // Validate out of sample.
  const candTrain = trainEval.summary(best)
  const candResults = testEval.results(best)
  const candTest = summarizeResults(candResults)
  metrics.candidate = { train: candTrain, test: candTest }

  const buy = Number(cfg.buyLamports)
  const edge = candTest.totalPnlLamports - curTest.totalPnlLamports
  const neededEdge = (o.minEdgePct / 100) * buy * Math.max(candTest.trades, 1)

  // Consistency: the edge must show in both halves of the test period.
  const mid = test.length ? test[Math.floor(test.length / 2)]!.t : now
  const byHalf = (p: TunableParams) => {
    const firstRows = test.filter((r) => r.t < mid)
    const secondRows = test.filter((r) => r.t >= mid)
    return [new Evaluator(firstRows, cfg).summary(p), new Evaluator(secondRows, cfg).summary(p)]
  }
  const [candA, candB] = byHalf(best)
  const [curA, curB] = byHalf(current)

  // Robustness: the edge must survive losing the candidate's single best
  // (winning) trade. Dropping a loss would only flatter the candidate.
  const bestWin = candResults.reduce((m, r) => Math.max(m, r.pnlLamports), 0)
  const edgeWithoutBest = candTest.totalPnlLamports - bestWin - curTest.totalPnlLamports

  const gates: Gate[] = [
    dataGate,
    {
      name: 'enough trades',
      pass: candTrain.trades >= o.minTrainTrades && candTest.trades >= o.minTestTrades,
      detail: `train ${candTrain.trades} (need ${o.minTrainTrades}), test ${candTest.trades} (need ${o.minTestTrades})`,
    },
    {
      name: 'wins out of sample',
      pass: edge >= neededEdge && edge > 0,
      detail: `test ${sol(curTest.totalPnlLamports)} → ${sol(candTest.totalPnlLamports)} (need +${sol(neededEdge)})`,
    },
    {
      name: 'profitable out of sample',
      pass: candTest.totalPnlLamports > 0,
      detail: `test total ${sol(candTest.totalPnlLamports)}`,
    },
    {
      name: 'consistent over time',
      pass: candA!.totalPnlLamports > curA!.totalPnlLamports && candB!.totalPnlLamports > curB!.totalPnlLamports,
      detail: `first half ${sol(curA!.totalPnlLamports)} → ${sol(candA!.totalPnlLamports)}, second half ${sol(curB!.totalPnlLamports)} → ${sol(candB!.totalPnlLamports)}`,
    },
    {
      name: 'not one lucky trade',
      pass: edgeWithoutBest > 0,
      detail: `edge without the best trade: ${sol(edgeWithoutBest)}`,
    },
    {
      name: 'drawdown in check',
      pass: candTest.maxDrawdownLamports <= curTest.maxDrawdownLamports * 1.25 + buy,
      detail: `max drawdown ${sol(curTest.maxDrawdownLamports)} → ${sol(candTest.maxDrawdownLamports)}`,
    },
  ]
  const failed = gates.filter((g) => !g.pass)
  return {
    ...base,
    candidate: best,
    changes,
    metrics,
    gates,
    decision: failed.length ? 'reject' : 'adopt',
    reason: failed.length ? `failed: ${failed.map((g) => g.name).join(', ')}` : `all ${gates.length} gates passed`,
  }
}

export interface ProbationResult {
  status: 'pending' | 'passed' | 'failed'
  trades: number
  newPnlLamports: number
  oldPnlLamports: number
  detail: string
}

/**
 * Forward check of adopted settings: on launches recorded since adoption
 * (never seen by the search), the new settings must do at least as well as
 * the ones they replaced. Otherwise they are rolled back.
 */
export function evaluateProbation(
  records: LaunchRecord[],
  cfg: Config,
  adopted: TunableParams,
  previous: TunableParams,
  since: number,
  neededTrades: number,
): ProbationResult {
  const post = records.filter((r) => r.t >= since).sort((a, b) => a.t - b.t)
  const e = new Evaluator(post, cfg)
  const n = e.summary(adopted)
  const old = e.summary(previous)
  const detail = `${n.trades} trades since adoption: new ${sol(n.totalPnlLamports)} vs previous ${sol(old.totalPnlLamports)}`
  if (n.trades < neededTrades) return { status: 'pending', trades: n.trades, newPnlLamports: n.totalPnlLamports, oldPnlLamports: old.totalPnlLamports, detail: `${detail} (need ${neededTrades})` }
  return {
    status: n.totalPnlLamports >= old.totalPnlLamports ? 'passed' : 'failed',
    trades: n.trades,
    newPnlLamports: n.totalPnlLamports,
    oldPnlLamports: old.totalPnlLamports,
    detail,
  }
}

export interface EdgeResult {
  /** proven: the settings make money on recent launches; trading may go on. */
  status: 'proven' | 'unproven' | 'insufficient-data'
  reason: string
  at: number
  /** `paramsKey` of the settings that were checked. */
  settingsKey: string
  recent?: Summary
  gates: Gate[]
}

/**
 * Does the strategy make money right now? Judged only on forward data:
 * launches recorded while exactly these settings were in effect (every
 * recording carries the fingerprint of the settings of its time), or
 * recorded after `since` when the settings were picked then (a
 * shadow-tested candidate). Settings are always picked from data recorded
 * before they took effect, so none of this data can have helped pick them:
 * a search result never proves itself, and trading waits for evidence that
 * arrived afterwards. Only the newest part of the recordings counts (the
 * share the tuner validates on), so the gate closes again when the market
 * turns. The bot only risks funds while this holds.
 */
export function evaluateEdge(records: LaunchRecord[], cfg: Config, params: TunableParams, o: TunerOptions, now = Date.now(), since?: number): EdgeResult {
  const fingerprint = settingsFingerprint(params)
  const frac = o.testFrac ?? 0.3
  const { test: window } = splitByTime([...records].sort((a, b) => a.t - b.t), frac)
  const sorted = window.filter((r) => r.settings === fingerprint || (since !== undefined && r.t >= since))
  const hours = sorted.length ? (sorted[sorted.length - 1]!.t - sorted[0]!.t) / 3_600_000 : 0
  const base = { at: now, settingsKey: paramsKey(params) }
  const needLaunches = Math.ceil(o.minLaunches * frac)
  const needHours = o.minHours * frac
  const dataGate: Gate = {
    name: 'enough forward data',
    pass: sorted.length >= needLaunches && hours >= needHours,
    detail: `${sorted.length} launches over ${hours.toFixed(1)}h recorded under these settings (need ${needLaunches} over ${needHours.toFixed(1)}h)`,
  }
  if (!dataGate.pass) return { ...base, status: 'insufficient-data', reason: `collecting forward data: ${dataGate.detail}`, gates: [dataGate] }

  const results = new Evaluator(sorted, cfg).results(params)
  const recent = summarizeResults(results)
  // Too few trades so far is no verdict yet, until the settings had the full
  // AUTOTUNE_MIN_HOURS to make them (settings that hardly trade are unproven).
  if (recent.trades < o.minTestTrades && hours < o.minHours) {
    const detail = `${recent.trades}/${o.minTestTrades} trades in ${hours.toFixed(1)}h recorded under these settings`
    return { ...base, recent, status: 'insufficient-data', reason: `collecting forward data: ${detail}`, gates: [dataGate, { name: 'enough trades', pass: false, detail }] }
  }
  const buy = Number(cfg.buyLamports)
  const needed = (o.minEdgePct / 100) * buy * Math.max(recent.trades, 1)
  const bestWin = results.reduce((m, r) => Math.max(m, r.pnlLamports), 0)
  const gates: Gate[] = [
    dataGate,
    { name: 'enough trades', pass: recent.trades >= o.minTestTrades, detail: `${recent.trades} forward trades (need ${o.minTestTrades})` },
    {
      name: 'makes money',
      pass: recent.totalPnlLamports > 0 && recent.totalPnlLamports >= needed,
      detail: `forward total ${sol(recent.totalPnlLamports)} (need +${sol(needed)})`,
    },
    { name: 'not one lucky trade', pass: recent.totalPnlLamports - bestWin > 0, detail: `without the best trade: ${sol(recent.totalPnlLamports - bestWin)}` },
  ]
  const cost = o.costPerDayLamports
  if (cost !== undefined && cost !== 0) {
    // Scale the replayed profit to a day of real trading: the window's length,
    // and the launches left out when the recordings were sampled.
    const spanDays = sorted.length > 1 ? (sorted[sorted.length - 1]!.t - sorted[0]!.t) / 86_400_000 : 0
    const perDay = spanDays > 0 ? (recent.totalPnlLamports * (o.sampleStride ?? 1)) / spanDays : 0
    gates.push(
      cost === null
        ? { name: 'covers its costs', pass: false, detail: 'SOL price unknown, cannot price the operating costs yet' }
        : { name: 'covers its costs', pass: perDay >= cost, detail: `≈${sol(perDay)}/day vs ${sol(cost)}/day of operating costs` },
    )
  }
  const failed = gates.filter((g) => !g.pass)
  return {
    ...base,
    recent,
    gates,
    status: failed.length ? 'unproven' : 'proven',
    reason: failed.length
      ? `no proven edge: ${failed.map((g) => g.name).join(', ')} (${recent.trades} forward trades, ${sol(recent.totalPnlLamports)})`
      : `${recent.trades} forward trades made ${sol(recent.totalPnlLamports)}`,
  }
}
