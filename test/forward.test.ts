import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { type CandidateSet, candidateSetFromResearch, contextChanges, forwardTest, loadCandidateSets, saveCandidates } from '../src/learning/forward.js'
import { searchStrategies } from '../src/learning/search.js'
import { paramsFromConfig } from '../src/learning/tunable.js'
import { earlyRug, momentumMarket, steadyPump } from './records.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'forward-'))
  dirs.push(d)
  return d
}

const START = 1_750_000_000_000
const cfg = loadConfig({ RPC_URL: 'https://x.example', RECORD_LAUNCHES: 'true', ENTRY_MODE: 'instant' })

const setWith = (frozenAt: number, over: Partial<CandidateSet> = {}): CandidateSet => ({
  v: 1,
  createdAt: frozenAt + 1_000,
  frozenAt,
  source: 'research',
  verdict: 'none',
  context: { buySol: 0.05, latencyMs: cfg.paperLatencyMs, roundTripNetworkSol: 0 },
  candidates: [{ label: 'blind sniping', params: paramsFromConfig(cfg), changes: [] }],
  ...over,
})

describe('forward test', () => {
  it('freezes the current settings and every research finalist at the end of the research data', () => {
    const records = momentumMarket(600, START)
    const r = searchStrategies(records, cfg, paramsFromConfig(cfg), { minLaunches: 200, minHours: 10, minTrades: 30, minEdgePct: 1, budgetMs: 60_000 }, 0)
    const set = candidateSetFromResearch(r, cfg, records, 123)
    expect(set.frozenAt).toBe(records[records.length - 1]!.t)
    expect(set.createdAt).toBe(123)
    expect(set.candidates[0]).toMatchObject({ label: 'current settings', changes: [] })
    expect(set.candidates).toHaveLength(r.finalists.length + 1)
    expect(set.candidates.filter((c) => c.label.endsWith('(best)'))).toHaveLength(1)
  })

  it('judges candidates only on launches recorded after they were frozen', () => {
    const frozenAt = START + 100 * 300_000
    // Before the freeze blind sniping looked brilliant; after it, every coin rugs.
    const before = Array.from({ length: 100 }, (_, i) => steadyPump(START + i * 300_000))
    const after = Array.from({ length: 60 }, (_, i) => earlyRug(frozenAt + (i + 1) * 300_000))
    const { launches, results } = forwardTest([...before, ...after], cfg, setWith(frozenAt), 50)
    expect(launches).toBe(60)
    expect(results[0]).toMatchObject({ label: 'blind sniping', verdict: 'fail' })
    expect(results[0]!.summary.trades).toBe(60)
    expect(results[0]!.summary.totalPnlLamports).toBeLessThan(0)
  })

  it('passes only with enough trades, a positive total, and still positive without the best trade', () => {
    const frozenAt = START
    const winners = Array.from({ length: 60 }, (_, i) => steadyPump(frozenAt + (i + 1) * 300_000))
    expect(forwardTest(winners.slice(0, 20), cfg, setWith(frozenAt), 50).results[0]).toMatchObject({ verdict: 'pending', detail: '20/50 trades so far' })
    const pass = forwardTest(winners, cfg, setWith(frozenAt), 50).results[0]!
    expect(pass.verdict).toBe('pass')
    expect(pass.withoutBestLamports).toBeGreaterThan(0)
  })

  it('saves and loads candidate sets, newest first, and says when conditions changed since', async () => {
    const dir = tmp()
    await saveCandidates(dir, setWith(START))
    await saveCandidates(dir, setWith(START + 86_400_000))
    writeFileSync(join(dir, 'candidates', 'notes.json'), '{"not": "ours"}')
    const sets = await loadCandidateSets(dir)
    expect(sets.map((s) => s.set.frozenAt)).toEqual([START + 86_400_000, START])
    expect(contextChanges(setWith(START), cfg)).toEqual([expect.stringMatching(/^network fees per round trip/)])
    expect(contextChanges(setWith(START, { context: { buySol: 0.1, latencyMs: 350, roundTripNetworkSol: 0 } }), cfg)[0]).toBe('trade size 0.1 → 0.05 SOL')
  })
})
