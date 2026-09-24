/**
 * Exit-strategy backtest on recorded launches.
 *
 *   npm run backtest [-- --days=7 --entry=instant|momentum|current --top=10 --min-trades=20 --quick]
 *
 * Replays every launch that passes the current filters under a grid of exit
 * settings, using the bot's own exit logic. Settings are ranked on the older
 * 70% of the data and checked on the newest 30%, which they were not chosen
 * on; a setting that only wins on the first part is overfit.
 */
import { config as loadDotenv } from 'dotenv'
import { type Config, loadConfig } from '../src/config.js'
import { loadTunedParams } from '../src/learning/autotune.js'
import { launchFromRecord, loadRecords, splitByTime } from '../src/learning/dataset.js'
import { type Summary, replayConfigFrom, replayLaunch, summarizeResults } from '../src/learning/replay.js'
import { SUMMARY_HEADERS, parseArgs, sol, summaryRow, table, writeReport } from '../src/learning/report.js'
import { applyParams } from '../src/learning/tunable.js'
import { staticFilter } from '../src/strategy/filters.js'

loadDotenv({ quiet: true })
const args = parseArgs()
const cfg = loadConfig({ RPC_URL: 'http://127.0.0.1:8899', ...process.env })
// Start from what the bot actually runs with, autotuned settings included.
const tuned = await loadTunedParams(cfg)
if (tuned) applyParams(cfg, tuned.params)
const minTrades = Number(args['min-trades'] ?? 20)
const top = Number(args.top ?? 10)
const entry = (args.entry === 'instant' || args.entry === 'momentum' ? args.entry : cfg.entryMode) as Config['entryMode']

const records = await loadRecords(cfg.dataDir, { days: args.days ? Number(args.days) : undefined })
const eligible = records.filter((r) =>
  staticFilter(launchFromRecord(r), cfg.filters, { initialRealTokenReserves: BigInt(r.initialRt), creatorLaunches: r.creatorLaunches }).pass,
)
if (eligible.length === 0) {
  console.log(`No recorded launches pass the current filters (${records.length} recorded in ${cfg.dataDir}/launches). Record more data first.`)
  process.exit(0)
}
const { train, test } = splitByTime(eligible)

type Exits = Config['exits']
interface Candidate {
  label: string
  env: Record<string, string>
  exits: Exits
}

const tpOptions = args.quick ? ['50:100', '60:50,150:100', '100:100'] : ['30:100', '50:100', '100:100', '200:100', '30:50,100:100', '60:50,150:100', '100:50,300:100']
const slOptions = args.quick ? [25] : [15, 25, 40]
const trailOptions: [number, number][] = args.quick ? [[0, 0], [20, 30]] : [[0, 0], [15, 20], [20, 30], [25, 50]]
const holdOptions = args.quick ? [180] : [60, 180, 600]
const staleOptions = args.quick ? [45] : [20, 45, 120]

const parseTp = (s: string) => s.split(',').map((p) => {
  const [g, v] = p.split(':').map(Number)
  return { gainPct: g!, sellPct: v! }
})
const candidates: Candidate[] = []
for (const tp of tpOptions)
  for (const sl of slOptions)
    for (const [trail, arm] of trailOptions)
      for (const hold of holdOptions)
        for (const stale of staleOptions) {
          const env = {
            TAKE_PROFIT: tp,
            STOP_LOSS_PCT: String(sl),
            TRAILING_STOP_PCT: String(trail),
            TRAILING_ARM_PCT: String(arm),
            MAX_HOLD_SECONDS: String(hold),
            STALE_SECONDS: String(stale),
          }
          candidates.push({
            label: `TP ${tp} · SL ${sl}% · trail ${trail ? `${trail}%@+${arm}%` : 'off'} · hold ${hold}s · stale ${stale}s`,
            env,
            exits: { ...cfg.exits, takeProfit: parseTp(tp), stopLossPct: sl, trailingStopPct: trail, trailingArmPct: arm, maxHoldMs: hold * 1000, staleMs: stale * 1000 },
          })
        }

const currentExits: Candidate = {
  label: 'current .env',
  env: {},
  exits: cfg.exits,
}
const run = (c: Candidate) => {
  const rc = replayConfigFrom(cfg, { entry, exits: c.exits })
  return { c, train: summarizeResults(train.map((r) => replayLaunch(r, rc))), test: summarizeResults(test.map((r) => replayLaunch(r, rc))) }
}

const started = Date.now()
process.stderr.write(`Backtesting ${candidates.length} exit settings on ${eligible.length} launches (${entry} entry)...\n`)
const results: { c: Candidate; train: Summary; test: Summary }[] = []
for (const [i, c] of candidates.entries()) {
  results.push(run(c))
  if (i % 50 === 49) process.stderr.write(`  ${i + 1}/${candidates.length}\n`)
}
const base = run(currentExits)
// Rank on training P&L; among ties prefer the smaller drawdown.
results.sort((a, b) => b.train.totalPnlLamports - a.train.totalPnlLamports || a.train.maxDrawdownLamports - b.train.maxDrawdownLamports)
const qualified = results.filter((r) => r.train.trades >= minTrades)

const out: string[] = []
const say = (s = '') => out.push(s)
say(`# Exit backtest — ${new Date().toISOString().slice(0, 16)} UTC`)
say()
if (tuned) say(`Includes the autotuned settings in data/tuning: ${tuned.changes.map((c) => `${c.env}=${c.to}`).join(', ')}.`)
say(`${eligible.length} launches pass the current filters (train ${train.length}, test ${test.length}); ${entry} entry, ${(Number(cfg.buyLamports) / 1e9).toFixed(3)} SOL per trade, ${cfg.paperLatencyMs} ms latency. ${candidates.length} settings in ${((Date.now() - started) / 1000).toFixed(1)}s.`)
if (train.length < 100) say(`\n> **Small sample.** Rankings on ${train.length} training launches are noisy; collect more data before acting on them.`)
say()
say('## Current settings')
say()
say(table(SUMMARY_HEADERS, [summaryRow('Train', base.train), summaryRow('Test', base.test)]))
say()
say(`## Top ${top} on training data`)
say()
say(table(
  ['#', 'Exit settings', 'Train trades', 'Train SOL', 'Train win', 'Test SOL', 'Test win', 'Test max DD'],
  qualified.slice(0, top).map((r, i) => [
    i + 1,
    r.c.label,
    r.train.trades,
    sol(r.train.totalPnlLamports),
    `${Math.round(r.train.winRate * 100)}%`,
    sol(r.test.totalPnlLamports),
    `${Math.round(r.test.winRate * 100)}%`,
    sol(-r.test.maxDrawdownLamports),
  ]),
))
say()
const rank = qualified.findIndex((r) => r.train.totalPnlLamports <= base.train.totalPnlLamports)
say(`The current settings would rank #${rank === -1 ? qualified.length + 1 : rank + 1} of ${qualified.length + 1} on the training data.`)
say()

const best = qualified[0]
const beats = best && best.train.totalPnlLamports > base.train.totalPnlLamports && best.test.totalPnlLamports > base.test.totalPnlLamports
if (best && beats && best.test.totalPnlLamports > 0) {
  say('## Recommendation')
  say()
  say(`**${best.c.label}** beat the current settings on both halves and made money on the test data (test ${sol(base.test.totalPnlLamports)} → ${sol(best.test.totalPnlLamports)} SOL). Try it in paper mode first:`)
  say()
  say('```env')
  for (const [k, v] of Object.entries(best.c.env)) say(`${k}=${v}`)
  say('```')
} else if (best && beats) {
  say('## Recommendation')
  say()
  say(`Keep the current exits: **${best.c.label}** loses less (test ${sol(base.test.totalPnlLamports)} → ${sol(best.test.totalPnlLamports)} SOL) but still loses. When no exit setting makes money, the entry is the problem: try \`--entry=momentum\` or \`--entry=instant\`.`)
} else if (best) {
  say('## Recommendation')
  say()
  say('Keep the current exits: the best training result did not also beat them on the test data, which points to overfitting rather than a better strategy.')
}
say()
say(table(SUMMARY_HEADERS, best ? [summaryRow('Best: train', best.train), summaryRow('Best: test', best.test)] : []))

const report = out.join('\n')
console.log(report)
console.log(`\nReport saved to ${await writeReport(cfg.dataDir, 'backtest', report)}`)
