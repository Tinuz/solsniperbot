/**
 * Learns from recorded launches (data/launches/*.jsonl).
 *
 *   npm run analyze [-- --days=7 --min-trades=20]
 *
 * Replays every recorded launch through the current .env settings and writes
 * a report to data/reports/: how the strategy would have done, whether each
 * filter actually avoids losers, which features separate winners from
 * losers, and filter thresholds that would have done better, but only when
 * they also win on the held-out most recent 30% of the data.
 */
import { config as loadDotenv } from 'dotenv'
import { type Config, loadConfig, solToLamports } from '../src/config.js'
import type { Launch } from '../src/feed/market.js'
import { launchFromRecord, loadRecords, splitByTime } from '../src/learning/dataset.js'
import type { LaunchRecord } from '../src/learning/record.js'
import { type ReplayResult, replayConfigFrom, replayLaunch, summarizeResults } from '../src/learning/replay.js'
import {
  FEATURE_LABELS,
  SUMMARY_HEADERS,
  features,
  num,
  parseArgs,
  pct,
  quantileEdges,
  sol,
  summaryRow,
  table,
  writeReport,
} from '../src/learning/report.js'
import { type FilterContext, staticFilter } from '../src/strategy/filters.js'

loadDotenv({ quiet: true })
const args = parseArgs()
const cfg = loadConfig({ RPC_URL: 'http://127.0.0.1:8899', ...process.env })
const minTrades = Number(args['min-trades'] ?? 20)
const records = await loadRecords(cfg.dataDir, { days: args.days ? Number(args.days) : undefined })

if (records.length === 0) {
  console.log(`No launch records in ${cfg.dataDir}/launches yet.\nRun the bot (paper mode is fine) with RECORD_LAUNCHES=true for a few hours, then run this again.`)
  process.exit(0)
}

interface Row {
  rec: LaunchRecord
  launch: Launch
  ctx: FilterContext
  pass: boolean
  reason: string
  /** The current strategy (filters aside): entry mode + exits. */
  now: ReplayResult
  /** Instant entry, for judging filters on every launch. */
  ifBought: ReplayResult
  f: Record<string, number>
}

const current = replayConfigFrom(cfg)
const instant = replayConfigFrom(cfg, { entry: 'instant' })
const rows: Row[] = records.map((rec) => {
  const launch = launchFromRecord(rec)
  const ctx = { initialRealTokenReserves: BigInt(rec.initialRt), creatorLaunches: rec.creatorLaunches }
  const v = staticFilter(launch, cfg.filters, ctx)
  return {
    rec,
    launch,
    ctx,
    pass: v.pass,
    reason: v.pass ? '' : v.reason,
    now: replayLaunch(rec, current),
    ifBought: replayLaunch(rec, instant),
    f: features(rec),
  }
})
const { train, test } = splitByTime(rows.map((r) => ({ ...r, t: r.rec.t })))
const out: string[] = []
const say = (s = '') => out.push(s)

// Overview -------------------------------------------------------------------
const span = (records[records.length - 1]!.t - records[0]!.t) / 3_600_000
const traded = rows.filter((r) => r.pass && r.now.entered)
say(`# Launch analysis — ${new Date().toISOString().slice(0, 16)} UTC`)
say()
say(`${records.length.toLocaleString()} launches over ${span.toFixed(1)} hours (${new Date(records[0]!.t).toISOString().slice(0, 16)} → ${new Date(records[records.length - 1]!.t).toISOString().slice(0, 16)} UTC).`)
say(`Replayed with the current settings: ${cfg.entryMode} entry, ${(Number(cfg.buyLamports) / 1e9).toFixed(3)} SOL per trade, ${cfg.paperLatencyMs} ms latency.`)
if (records.length < 500 || traded.length < 50) {
  say()
  say(`> **Small sample.** ${traded.length} simulated trades is too few to trust; treat everything below as anecdotes until there are a few days of data.`)
}
say()

// Strategy -------------------------------------------------------------------
say('## What the current strategy would have made')
say()
const passTrain = train.filter((r) => r.pass)
const passTest = test.filter((r) => r.pass)
say(table(SUMMARY_HEADERS, [
  summaryRow('All data', summarizeResults(rows.filter((r) => r.pass).map((r) => r.now))),
  summaryRow('Train (older 70%)', summarizeResults(passTrain.map((r) => r.now))),
  summaryRow('Test (newest 30%)', summarizeResults(passTest.map((r) => r.now))),
]))
say()
const exitCounts = new Map<string, { n: number; pnl: number }>()
for (const r of traded) {
  const key = (r.now.exits[r.now.exits.length - 1] ?? 'none').replace(/[-+]?\d+(\.\d+)?%?/g, 'N')
  const e = exitCounts.get(key) ?? { n: 0, pnl: 0 }
  e.n++
  e.pnl += r.now.pnlLamports
  exitCounts.set(key, e)
}
say(table(['Final exit', 'Trades', 'Total SOL'], [...exitCounts].sort((a, b) => b[1].n - a[1].n).map(([k, v]) => [k, v.n, sol(v.pnl)])))
say()
const cutOff = exitCounts.get('recording ended')?.n ?? 0
if (cutOff > traded.length * 0.1) {
  say(`> ${cutOff} trades were still open when their recording ended and are valued at the last recorded price. Set RECORD_HORIZON_MIN above MAX_HOLD_SECONDS so exits play out.`)
  say()
}

// Calibration ------------------------------------------------------------------
const actual = rows.filter((r) => r.rec.position && r.now.entered && r.rec.position.exits.length && !r.rec.position.exits[0]!.startsWith('buy failed'))
if (actual.length) {
  const diffs = actual.map((r) => r.now.pnlLamports - r.rec.position!.pnlLamports)
  const meanDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length
  const botTotal = actual.reduce((a, r) => a + r.rec.position!.pnlLamports, 0)
  say('### Replay vs. what the bot actually did')
  say()
  say(`${actual.length} launches were traded by the bot and replayed. Bot total ${sol(botTotal)} SOL; replay differs by ${sol(meanDiff)} SOL per trade on average.`)
  say('A large gap means the replay is optimistic or pessimistic (latency, slippage, fees); weigh its suggestions accordingly.')
  say()
}

// Filters --------------------------------------------------------------------
say('## Filter audit: would the rejected launches have made money?')
say()
say('Each rejected launch is replayed as if bought instantly. A filter earns its keep when its rejects do worse than what passes.')
say()
const passedInstant = summarizeResults(rows.filter((r) => r.pass).map((r) => r.ifBought))
const groups = new Map<string, Row[]>()
for (const r of rows) {
  if (r.pass) continue
  const key = r.reason.replace(/[-+]?\d+(\.\d+)?/g, 'N')
  groups.set(key, [...(groups.get(key) ?? []), r])
}
say(table(
  ['Rejected because', 'Launches', 'Would-be win rate', 'Mean', 'Total SOL', 'Verdict'],
  [
    ['*(passed the filters)*', rows.filter((r) => r.pass).length, `${Math.round(passedInstant.winRate * 100)}%`, pct(passedInstant.meanPnlPct), sol(passedInstant.totalPnlLamports), ''],
    ...[...groups]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([reason, g]) => {
        const s = summarizeResults(g.map((r) => r.ifBought))
        const helps = s.trades === 0 || s.meanPnlPct <= passedInstant.meanPnlPct
        return [reason, g.length, s.trades ? `${Math.round(s.winRate * 100)}%` : '–', s.trades ? pct(s.meanPnlPct) : '–', sol(s.totalPnlLamports), helps ? 'helps' : '**costs you**']
      }),
  ],
))
say()

// Features ---------------------------------------------------------------------
say('## What separates winners from losers')
say()
say('Every launch replayed as an instant buy, split into five equal-sized groups per feature. (Dev supply % and mcap at detection follow directly from the dev buy, so they are not listed separately.)')
say()
for (const [key, label] of Object.entries(FEATURE_LABELS).filter(([k]) => k !== 'devSupplyPct' && k !== 'mcapSol')) {
  const values = rows.map((r) => r.f[key]!)
  const edges = quantileEdges(values, 5)
  if (edges.length === 0) continue
  const bounds = [Number.NEGATIVE_INFINITY, ...edges, Number.POSITIVE_INFINITY]
  const bucketRows: (string | number)[][] = []
  for (let i = 0; i < bounds.length - 1; i++) {
    const lo = bounds[i]!
    const hi = bounds[i + 1]!
    const inBucket = rows.filter((r) => r.f[key]! >= lo && r.f[key]! < hi)
    if (!inBucket.length) continue
    const s = summarizeResults(inBucket.map((r) => r.ifBought))
    const range = `${Number.isFinite(lo) ? num(lo) : 'min'} – ${Number.isFinite(hi) ? `<${num(hi)}` : 'max'}`
    bucketRows.push([range, inBucket.length, s.trades ? `${Math.round(s.winRate * 100)}%` : '–', s.trades ? pct(s.meanPnlPct) : '–', s.trades ? pct(s.medianPnlPct) : '–'])
  }
  say(`### ${label}`)
  say()
  say(table(['Range', 'Launches', 'Win rate', 'Mean', 'Median'], bucketRows))
  say()
}

// Suggestions ----------------------------------------------------------------
say('## Suggested filter changes')
say()
say(`A value is suggested only if, with every other setting unchanged, it beats the current value on the older 70% of the data **and** on the newest 30% it was not tuned on (min ${minTrades} trades).`)
say()
const q = (key: string, k = 10) => quantileEdges(rows.map((r) => r.f[key]!), k)
const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d
const knobs: { env: string; current: number; candidates: number[]; apply: (v: number) => Config['filters'] }[] = [
  { env: 'DEV_BUY_MIN_SOL', current: Number(cfg.filters.devBuyMinLamports) / 1e9, candidates: [0, ...q('devBuySol').map((v) => round(v, 2))], apply: (v) => ({ ...cfg.filters, devBuyMinLamports: solToLamports(v) }) },
  { env: 'DEV_BUY_MAX_SOL', current: Number(cfg.filters.devBuyMaxLamports) / 1e9, candidates: q('devBuySol').map((v) => round(v, 2)), apply: (v) => ({ ...cfg.filters, devBuyMaxLamports: solToLamports(v) }) },
  { env: 'DEV_MAX_SUPPLY_PCT', current: cfg.filters.devMaxSupplyPct, candidates: q('devSupplyPct').map((v) => round(v, 1)), apply: (v) => ({ ...cfg.filters, devMaxSupplyPct: v }) },
  { env: 'MAX_ENTRY_MCAP_SOL', current: Number(cfg.filters.maxEntryMcapLamports) / 1e9, candidates: q('mcapSol').map((v) => round(v, 1)), apply: (v) => ({ ...cfg.filters, maxEntryMcapLamports: solToLamports(v) }) },
  { env: 'CREATOR_MAX_LAUNCHES', current: cfg.filters.creatorMaxLaunches, candidates: [1, 2, 3, 4, 6, 10], apply: (v) => ({ ...cfg.filters, creatorMaxLaunches: v }) },
]
const evaluate = (set: typeof train, filters: Config['filters']) =>
  summarizeResults(set.filter((r) => staticFilter(r.launch, filters, r.ctx).pass).map((r) => r.now))
const baseTrain = evaluate(train, cfg.filters)
const baseTest = evaluate(test, cfg.filters)
const suggestionRows: (string | number)[][] = []
const envLines: string[] = []
for (const k of knobs) {
  let best: { v: number; train: ReturnType<typeof evaluate> } | undefined
  for (const v of [...new Set(k.candidates)]) {
    const s = evaluate(train, k.apply(v))
    if (s.trades < minTrades) continue
    if (!best || s.totalPnlLamports > best.train.totalPnlLamports) best = { v, train: s }
  }
  if (!best || best.v === k.current || best.train.totalPnlLamports <= baseTrain.totalPnlLamports) {
    suggestionRows.push([k.env, num(k.current), '–', 'keep (no improvement)', '', ''])
    continue
  }
  const bestTest = evaluate(test, k.apply(best.v))
  const robust = bestTest.totalPnlLamports > baseTest.totalPnlLamports && bestTest.trades >= Math.min(minTrades, baseTest.trades)
  suggestionRows.push([
    k.env,
    num(k.current),
    num(best.v),
    robust ? '**change**' : 'keep (did not hold up on test data)',
    `${sol(baseTrain.totalPnlLamports)} → ${sol(best.train.totalPnlLamports)}`,
    `${sol(baseTest.totalPnlLamports)} → ${sol(bestTest.totalPnlLamports)}`,
  ])
  if (robust) envLines.push(`${k.env}=${num(best.v)}`)
}
say(table(['Setting', 'Current', 'Best on train', 'Advice', 'Train SOL', 'Test SOL'], suggestionRows))
say()
if (envLines.length) {
  say('Each change was tested on its own; they can interact. Apply them, run a while in paper mode, then analyze again:')
  say()
  say('```env')
  for (const l of envLines) say(l)
  say('```')
} else {
  say('No filter change beat the current settings on both halves of the data.')
}
say()
say('Tune exits with `npm run backtest`.')

const report = out.join('\n')
console.log(report)
const path = await writeReport(cfg.dataDir, 'analysis', report)
console.log(`\nReport saved to ${path}`)
