/**
 * Forward test of frozen candidates, without trading them.
 *
 *   npm run forward [-- --sets=3 --min-trades=50 --max=40000]
 *
 * `npm run research` freezes the settings in effect and its finalists, with
 * the moment its data ended. This replays each of them on the launches
 * recorded after that moment, which none of them could have been fitted to,
 * and judges them on what was agreed up front: at least 50 trades, a
 * positive total, and still positive without the single best trade.
 */
import { config as loadDotenv } from 'dotenv'
import { loadConfig } from '../src/config.js'
import { loadSample } from '../src/learning/dataset.js'
import { type ForwardResult, contextChanges, forwardTest, loadCandidateSets } from '../src/learning/forward.js'
import { parseArgs, pct, sol, table, writeReport } from '../src/learning/report.js'

loadDotenv({ quiet: true })
const args = parseArgs()
const cfg = loadConfig({ RPC_URL: 'http://127.0.0.1:8899', ...process.env })
const minTrades = Number(args['min-trades'] ?? 50)
const sets = (await loadCandidateSets(cfg.dataDir)).slice(0, Number(args.sets ?? 3))
if (!sets.length) {
  console.log('No frozen candidates yet. Run `npm run research` first: it freezes the current settings and its finalists for a forward test.')
  process.exit(0)
}

const oldest = sets.reduce((m, s) => Math.min(m, s.set.frozenAt), Number.POSITIVE_INFINITY)
const days = Math.ceil((Date.now() - oldest) / 86_400_000) + 1
console.error(`Loading launches recorded since ${new Date(oldest).toISOString().slice(0, 16)} UTC...`)
const { records, stride } = await loadSample(cfg.dataDir, { days, max: Number(args.max ?? 40_000) })

const out: string[] = []
const say = (s = '') => out.push(s)
const iso = (t: number) => `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`
const mark: Record<ForwardResult['verdict'], string> = { pass: '✅ pass', fail: '❌ fail', pending: '⏳ pending' }

say(`# Forward test — ${iso(Date.now())}`)
say()
say(
  `Candidates frozen by \`npm run research\`, replayed on launches recorded after they were frozen. Agreed up front: at least ${minTrades} trades, a positive total, and still positive without the single best trade.`,
)
if (stride > 1) say(`Launches are an even sample (1 in ${stride.toFixed(1)}): trade counts are lower than the bot would have made; the verdicts hold for the sample.`)
say()

for (const { file, set } of sets) {
  const { launches, results } = forwardTest(records, cfg, set, minTrades)
  const fresh = records.filter((r) => r.t > set.frozenAt)
  const hours = fresh.length ? (fresh[fresh.length - 1]!.t - set.frozenAt) / 3_600_000 : 0
  say(`## Research of ${iso(set.createdAt)} (verdict then: ${set.verdict ?? '–'})`)
  say()
  say(`Frozen at ${iso(set.frozenAt)} (\`${file}\`). Since then: ${launches.toLocaleString()} launches over ${hours.toFixed(1)} hours.`)
  const changed = contextChanges(set, cfg)
  if (changed.length) say(`> Conditions changed since it was frozen (${changed.join('; ')}): these results use today's .env.`)
  say()
  if (!launches) {
    say('No launches recorded since yet.')
    say()
    continue
  }
  const sorted = [...results].sort((a, b) => b.summary.totalPnlLamports - a.summary.totalPnlLamports)
  say(
    table(
      ['Candidate', 'Trades', 'Win rate', 'Total SOL', 'Without best', 'Mean', 'Verdict', 'Settings (vs. then)'],
      sorted.map((r) => [
        r.label,
        r.summary.trades,
        r.summary.trades ? `${Math.round(r.summary.winRate * 100)}%` : '–',
        sol(r.summary.totalPnlLamports),
        sol(r.withoutBestLamports),
        r.summary.trades ? pct(r.summary.meanPnlPct) : '–',
        mark[r.verdict],
        r.changes.length ? r.changes.map((c) => `${c.env}=${c.to}`).join(', ') : '(as they were)',
      ]),
    ),
  )
  say()
  const passed = results.filter((r) => r.verdict === 'pass')
  if (passed.length) {
    say(
      `${passed.length} of ${results.length} passed. With this many candidates, one can pass by luck: a pass earns a paper test of its own (or freezing it again and waiting), not live trading yet.`,
    )
  } else if (results.every((r) => r.verdict === 'pending')) {
    say(`Not enough trades yet to judge. Run this again in a day or two.`)
  } else {
    say('No candidate passed so far.')
  }
  say()
}

const report = out.join('\n')
console.log(report)
console.log(`\nReport saved to ${await writeReport(cfg.dataDir, 'forward', report)}`)
