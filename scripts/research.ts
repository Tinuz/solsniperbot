/**
 * Is there a profitable strategy in the recorded launches, and what is it?
 *
 *   npm run research [-- --days=7 --budget=10 --min-trades=60]
 *
 * Searches entry, filter and exit settings far beyond one step from the
 * current ones (within the absolute bounds), on the oldest 60% of the data.
 * The best candidates compete on the next 20%, and the winner must also make
 * money on the newest 20%, which neither step used. Reports whether such a
 * strategy exists and how to use it.
 */
import { config as loadDotenv } from 'dotenv'
import { loadConfig } from '../src/config.js'
import { loadTunedParams } from '../src/learning/autotune.js'
import { loadSample } from '../src/learning/dataset.js'
import { SUMMARY_HEADERS, parseArgs, sol, summaryRow, table, writeReport } from '../src/learning/report.js'
import { candidateSetFromResearch, saveCandidates } from '../src/learning/forward.js'
import { type Scored, searchStrategies } from '../src/learning/search.js'
import { applyParams, paramsFromConfig, toEnv } from '../src/learning/tunable.js'

loadDotenv({ quiet: true })
const args = parseArgs()
const cfg = loadConfig({ RPC_URL: 'http://127.0.0.1:8899', ...process.env })
const tuned = await loadTunedParams(cfg)
if (tuned) applyParams(cfg, tuned.params)
const budgetMin = Number(args.budget ?? 10)
const { records, stride } = await loadSample(cfg.dataDir, { days: args.days ? Number(args.days) : cfg.autotune.days, max: cfg.autotune.maxLaunches })
if (records.length === 0) {
  console.log(`No launch records in ${cfg.dataDir}/launches yet. Let the bot record for a day first.`)
  process.exit(0)
}

console.error(`Searching ${records.length.toLocaleString()} launches for up to ${budgetMin} min...`)
const current = paramsFromConfig(cfg)
const r = searchStrategies(records, cfg, current, {
  minLaunches: Number(args['min-launches'] ?? cfg.autotune.minLaunches),
  minHours: Number(args['min-hours'] ?? cfg.autotune.minHours),
  minTrades: Number(args['min-trades'] ?? cfg.autotune.minTrainTrades),
  minEdgePct: cfg.autotune.minEdgePct,
  budgetMs: budgetMin * 60_000,
})

const out: string[] = []
const say = (s = '') => out.push(s)
const compact = (f: Scored) => (f.changes.length ? f.changes.map((c) => `${c.env}=${c.to}`).join(', ') : '(current settings)')

say(`# Strategy research — ${new Date().toISOString().slice(0, 16)} UTC`)
say()
say(`${r.data.launches.toLocaleString()} launches over ${r.data.hours.toFixed(1)} hours${stride > 1 ? ` (an even sample: 1 in ${stride.toFixed(1)})` : ''}. Searched on the oldest ${r.data.train.toLocaleString()}, compared on the next ${r.data.validation.toLocaleString()}, tested on the newest ${r.data.test.toLocaleString()}.`)
say(`${r.evaluated.toLocaleString()} strategies evaluated in ${(r.ms / 1000).toFixed(0)}s${tuned ? ', starting from the autotuned settings' : ''}. ${(Number(cfg.buyLamports) / 1e9).toFixed(3)} SOL per trade, ${cfg.paperLatencyMs} ms latency, fees included.`)
say()
say(`## Verdict: ${r.decision === 'found' ? 'FOUND a strategy that holds up' : r.decision === 'insufficient-data' ? 'NOT ENOUGH DATA' : 'NONE held up'}`)
say()
say(r.reason)
say()
if (r.current) {
  say('## Current settings')
  say()
  say(table(SUMMARY_HEADERS, [summaryRow('Search part', r.current.train), summaryRow('Validation part', r.current.validation), summaryRow('Test part', r.current.test)]))
  say()
}
if (r.best) {
  say(`## Best candidate${r.decision === 'found' ? '' : ' (did not pass)'}`)
  say()
  say(r.best.changes.length ? table(['Setting', 'Current', 'Candidate'], r.best.changes.map((c) => [c.env, c.from, c.to])) : 'The current settings themselves.')
  say()
  say(table(SUMMARY_HEADERS, [summaryRow('Search part', r.best.train), summaryRow('Validation part', r.best.validation), summaryRow('Test part', r.best.test)]))
  say()
  say(table(['Gate', 'Result', 'Detail'], r.gates.map((g) => [g.name, g.pass ? 'pass' : 'FAIL', g.detail])))
  say()
  if (r.decision === 'found' && r.best.changes.length) {
    say('To use it, put these lines in .env and run in paper mode first. With AUTOTUNE=paper the bot also finds and adopts such a strategy by itself while it is observing.')
    say()
    say('```env')
    const env = toEnv(r.best.params)
    for (const c of r.best.changes) say(`${c.env}=${env[c.env]}`)
    say('```')
    say()
  }
}
if (r.finalists.length > 1) {
  say('## Other finalists')
  say()
  say('The strongest strategies on the search part, and how they did on the validation part.')
  say()
  say(table(
    ['Settings (differences from current)', 'Search trades', 'Search SOL', 'Validation trades', 'Validation SOL'],
    r.finalists.map((f) => [compact(f), f.train.trades, sol(f.train.totalPnlLamports), f.validation.trades, sol(f.validation.totalPnlLamports)]),
  ))
  say()
}
if (r.decision === 'none') {
  say('No strategy within the bounds made money on data it was not chosen on. More data may change that; so may market conditions. The bot keeps observing instead of trading, which is the right call until something holds up.')
}

// Freeze the current settings and every finalist: `npm run forward` judges them on launches recorded from now on.
if (r.finalists.length) {
  const path = await saveCandidates(cfg.dataDir, candidateSetFromResearch(r, cfg, records))
  say(`## Forward test`)
  say()
  say(`The current settings and the ${r.finalists.length} finalists are frozen in \`${path}\`. In a few days, \`npm run forward\` replays them on launches recorded after ${new Date(records[records.length - 1]!.t).toISOString().slice(0, 16)} UTC, which none of them could have been fitted to.`)
}

const report = out.join('\n')
console.log(report)
console.log(`\nReport saved to ${await writeReport(cfg.dataDir, 'research', report)}`)
