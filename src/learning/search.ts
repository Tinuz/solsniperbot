import type { Config } from '../config.js'
import type { LaunchRecord } from './record.js'
import { type Summary, summarizeResults } from './replay.js'
import { type ParamChange, type TunableParams, diffParams, neighbors, paramsKey, withinBounds } from './tunable.js'
import { Evaluator, type Gate, type Outcome } from './tuner.js'

export interface SearchOptions {
  minLaunches: number
  minHours: number
  /** Minimum trades in the search part; the validation and test parts need 40% of it. */
  minTrades: number
  /** Required test profit per trade, as % of the trade size. */
  minEdgePct: number
  /** Stop searching after this long (the best found so far is still validated). */
  budgetMs: number
  /** Settings (`paramsKey`) never to pick, e.g. ones that failed probation. */
  exclude?: string[]
}

export interface Scored {
  params: TunableParams
  changes: ParamChange[]
  train: Summary
  validation: Summary
}

export interface StrategySearchResult {
  at: number
  /** found: a strategy that also makes money on the two parts the search never used. */
  decision: 'found' | 'none' | 'insufficient-data'
  reason: string
  data: { launches: number; hours: number; train: number; validation: number; test: number }
  evaluated: number
  ms: number
  current?: { train: Summary; validation: Summary; test: Summary }
  best?: Scored & { test: Summary }
  finalists: Scored[]
  gates: Gate[]
}

const sol = (lamports: number) => `${(lamports / 1e9).toFixed(4)} SOL`
const TRAIN = 0.6
const VALIDATION = 0.2
const MAX_ROUNDS = 5
const FINALISTS = 10

const MOONBAG: Partial<TunableParams> = { moonbagPct: 25, moonbagSecurePct: 10, moonbagStopBufferPct: 5, moonbagTrailingPct: 40 }

/**
 * Starting points far apart, so the search does not only explore around the
 * current settings: blind and patient entries, quick and slow exits, with and
 * without the insider filters, with and without a moonbag.
 */
const SEEDS: Partial<TunableParams>[] = [
  MOONBAG,
  { entryMode: 'momentum', momentumMinBuyers: 4, momentumMinNetBuySol: 1, ...MOONBAG },
  // Follow smart money: buy when a proven wallet does, with little else required.
  { entryMode: 'momentum', momentumMinBuyers: 1, momentumMinNetBuySol: 0.1, momentumMaxSellRatio: 1, momentumMinSmartBuyers: 1, ...MOONBAG },
  { entryMode: 'instant' },
  { entryMode: 'momentum' },
  { entryMode: 'momentum', momentumMinBuyers: 3, momentumMinNetBuySol: 0.5, momentumMaxSellRatio: 0.6 },
  { entryMode: 'momentum', momentumMinBuyers: 8, momentumMinNetBuySol: 3, momentumMaxSellRatio: 0.3, momentumMaxEarlyBuySol: 1, momentumMaxTopBuyerPct: 5 },
  {
    entryMode: 'momentum',
    momentumMinBuyers: 4,
    momentumMinNetBuySol: 1,
    takeProfit: [{ gainPct: 40, sellPct: 100 }],
    stopLossPct: 15,
    trailingStopPct: 15,
    trailingArmPct: 20,
    maxHoldSec: 60,
    staleSec: 20,
  },
  {
    entryMode: 'momentum',
    momentumMinBuyers: 6,
    momentumMinNetBuySol: 2,
    takeProfit: [{ gainPct: 100, sellPct: 50 }, { gainPct: 300, sellPct: 100 }],
    stopLossPct: 35,
    trailingStopPct: 25,
    trailingArmPct: 50,
    maxHoldSec: 600,
    staleSec: 120,
  },
]

/** P&L without the single best trade: a strategy that lives off one lucky coin scores low. */
function robust(results: Outcome[], minTrades: number): number {
  const s = summarizeResults(results)
  if (s.trades < minTrades) return Number.NEGATIVE_INFINITY
  const bestWin = results.reduce((m, r) => (r.entered ? Math.max(m, r.pnlLamports) : m), 0)
  return s.totalPnlLamports - bestWin
}

/**
 * Looks for a profitable strategy anywhere within the absolute bounds, not
 * only one step from the current settings.
 *
 * Honest by construction: the search runs on the oldest 60% of the
 * recordings, the best candidates are then compared on the next 20%, and the
 * winner must also make money on the newest 20%, which neither step saw.
 * Scores leave out each strategy's single best trade.
 */
export function searchStrategies(records: LaunchRecord[], cfg: Config, current: TunableParams, o: SearchOptions, now = Date.now()): StrategySearchResult {
  const started = performance.now()
  const sorted = [...records].sort((a, b) => a.t - b.t)
  const hours = sorted.length ? (sorted[sorted.length - 1]!.t - sorted[0]!.t) / 3_600_000 : 0
  const a = Math.floor(sorted.length * TRAIN)
  const b = Math.floor(sorted.length * (TRAIN + VALIDATION))
  const parts = { train: sorted.slice(0, a), validation: sorted.slice(a, b), test: sorted.slice(b) }
  const base = {
    at: now,
    data: { launches: sorted.length, hours, train: parts.train.length, validation: parts.validation.length, test: parts.test.length },
    finalists: [] as Scored[],
  }
  const dataGate: Gate = {
    name: 'enough data',
    pass: sorted.length >= o.minLaunches && hours >= o.minHours,
    detail: `${sorted.length} launches over ${hours.toFixed(1)}h (need ${o.minLaunches} over ${o.minHours}h)`,
  }
  if (!dataGate.pass) return { ...base, decision: 'insufficient-data', reason: dataGate.detail, evaluated: 0, ms: 0, gates: [dataGate] }

  const train = new Evaluator(parts.train, cfg)
  const validation = new Evaluator(parts.validation, cfg)
  const test = new Evaluator(parts.test, cfg)
  const minHeldOut = Math.max(5, Math.ceil(o.minTrades * 0.4))
  const excluded = new Set(o.exclude ?? [])
  const scores = new Map<string, { params: TunableParams; score: number }>()
  const timeUp = () => performance.now() - started > o.budgetMs

  const score = (p: TunableParams) => {
    const key = paramsKey(p)
    const hit = scores.get(key)
    if (hit) return hit.score
    const s = excluded.has(key) ? Number.NEGATIVE_INFINITY : robust(train.results(p), o.minTrades)
    scores.set(key, { params: p, score: s })
    return s
  }

  // Multi-start local search on the training part, bounded only by the absolute limits.
  const seeds = [current, ...SEEDS.map((patch) => ({ ...current, ...patch }))].filter((p, i) => i === 0 || withinBounds(p))
  for (const seed of seeds) {
    if (timeUp()) break
    let best = seed
    let bestScore = score(seed)
    for (let round = 0; round < MAX_ROUNDS && !timeUp(); round++) {
      let next = best
      let nextScore = bestScore
      for (const { params } of neighbors(best)) {
        if (timeUp()) break
        if (!withinBounds(params)) continue
        const s = score(params)
        if (s > nextScore) {
          next = params
          nextScore = s
        }
      }
      if (next === best) break
      best = next
      bestScore = nextScore
    }
  }

  // The best few on training data compete on the validation part. Settings
  // that make exactly the same trades count once, as the simplest of them.
  const finalists: Scored[] = []
  const seen = new Set<string>()
  const candidates = [...scores.values()]
    .filter((e) => Number.isFinite(e.score))
    .map((e) => ({ ...e, changes: diffParams(current, e.params) }))
    .sort((x, y) => y.score - x.score || x.changes.length - y.changes.length)
  for (const e of candidates) {
    const s = train.summary(e.params)
    const same = `${e.score}:${s.trades}:${s.totalPnlLamports}`
    if (seen.has(same)) continue
    seen.add(same)
    finalists.push({ params: e.params, changes: e.changes, train: s, validation: validation.summary(e.params) })
    if (finalists.length === FINALISTS) break
  }
  const ranked = finalists
    .map((f) => ({ f, v: robust(validation.results(f.params), minHeldOut) }))
    .filter((x) => Number.isFinite(x.v))
    .sort((x, y) => y.v - x.v)

  const currentSummaries = { train: train.summary(current), validation: validation.summary(current), test: test.summary(current) }
  const done = { ...base, finalists, evaluated: scores.size, current: currentSummaries }
  const chosen = ranked[0]?.f
  if (!chosen) {
    return {
      ...done,
      ms: performance.now() - started,
      decision: 'none',
      reason: `no strategy made at least ${o.minTrades} trades in the search part and ${minHeldOut} in the validation part`,
      gates: [dataGate],
    }
  }

  // Final exam on the newest part, which played no role in finding or choosing it.
  const results = test.results(chosen.params)
  const t = summarizeResults(results)
  const buy = Number(cfg.buyLamports)
  const needed = (o.minEdgePct / 100) * buy * Math.max(t.trades, 1)
  const bestWin = results.reduce((m, r) => (r.entered ? Math.max(m, r.pnlLamports) : m), 0)
  const mid = parts.test.length ? parts.test[Math.floor(parts.test.length / 2)]!.t : now
  const halves = [parts.test.filter((r) => r.t < mid), parts.test.filter((r) => r.t >= mid)].map((rs) => new Evaluator(rs, cfg).summary(chosen.params))
  const gates: Gate[] = [
    dataGate,
    {
      name: 'enough trades',
      pass: chosen.validation.trades >= minHeldOut && t.trades >= minHeldOut,
      detail: `validation ${chosen.validation.trades}, test ${t.trades} (need ${minHeldOut} each)`,
    },
    { name: 'profitable in validation', pass: chosen.validation.totalPnlLamports > 0, detail: `validation total ${sol(chosen.validation.totalPnlLamports)}` },
    { name: 'profitable in test', pass: t.totalPnlLamports > 0 && t.totalPnlLamports >= needed, detail: `test total ${sol(t.totalPnlLamports)} (need +${sol(needed)})` },
    { name: 'not one lucky trade', pass: t.totalPnlLamports - bestWin > 0, detail: `test without its best trade: ${sol(t.totalPnlLamports - bestWin)}` },
    {
      name: 'consistent over time',
      pass: halves.every((h) => h.totalPnlLamports > 0),
      detail: `test halves ${halves.map((h) => sol(h.totalPnlLamports)).join(' / ')}`,
    },
  ]
  const failed = gates.filter((g) => !g.pass)
  return {
    ...done,
    ms: performance.now() - started,
    best: { ...chosen, test: t },
    gates,
    decision: failed.length ? 'none' : 'found',
    reason: failed.length
      ? `best candidate failed: ${failed.map((g) => g.name).join(', ')}`
      : `makes ${sol(t.totalPnlLamports)} over ${t.trades} trades in the newest ${Math.round((1 - TRAIN - VALIDATION) * 100)}% of the data, which the search never used`,
  }
}
