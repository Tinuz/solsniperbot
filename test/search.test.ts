import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { searchStrategies } from '../src/learning/search.js'
import { paramsFromConfig, paramsKey, withinBounds } from '../src/learning/tunable.js'
import { Evaluator } from '../src/learning/tuner.js'
import { deadCoin, earlyRug, momentumMarket } from './records.js'

const START = 1_750_000_000_000
const OPTS = { minLaunches: 200, minHours: 10, minTrades: 30, minEdgePct: 1, budgetMs: 60_000 }
/** Full strategy searches are CPU-bound: slower machines need more than the default limit. */
const HEAVY_MS = 90_000
const cfgWith = (over: Record<string, string> = {}) =>
  loadConfig({ DRY_RUN: 'true', RPC_URL: 'https://example.com', RECORD_LAUNCHES: 'true', ENTRY_MODE: 'instant', ...over })

describe('strategy search', () => {
  it('finds a profitable strategy far from the current settings, and proves it on data it never used', () => {
    const cfg = cfgWith()
    const current = paramsFromConfig(cfg)
    const records = momentumMarket(600)
    const r = searchStrategies(records, cfg, current, OPTS, 0)
    expect(r.decision).toBe('found')
    expect(r.data).toMatchObject({ launches: 600, train: 360, validation: 120, test: 120 })
    expect(r.gates.every((g) => g.pass)).toBe(true)
    const best = r.best!
    expect(best.params.entryMode).toBe('momentum')
    expect(withinBounds(best.params)).toBe(true)
    expect(best.test.totalPnlLamports).toBeGreaterThan(0)
    // The current settings are reported next to the winner, which beats them on the unseen part.
    expect(best.test.totalPnlLamports).toBeGreaterThan(r.current!.test.totalPnlLamports)
    // The test result is an honest replay of the newest 20% alone.
    expect(best.test).toEqual(new Evaluator(records.slice(480), cfg).summary(best.params))
    expect(r.finalists.length).toBeGreaterThan(1)
    expect(r.evaluated).toBeGreaterThan(50)
  }, HEAVY_MS)

  it('finds nothing when every coin dies or rugs', () => {
    const cfg = cfgWith()
    const records = Array.from({ length: 600 }, (_, i) => (i % 2 ? deadCoin : earlyRug)(START + i * 300_000))
    const r = searchStrategies(records, cfg, paramsFromConfig(cfg), OPTS, 0)
    expect(r.decision).toBe('none')
    expect(r.best?.test.totalPnlLamports ?? 0).toBeLessThanOrEqual(0)
  })

  it('needs enough data before it searches', () => {
    const cfg = cfgWith()
    const r = searchStrategies(momentumMarket(100), cfg, paramsFromConfig(cfg), OPTS, 0)
    expect(r.decision).toBe('insufficient-data')
    expect(r.evaluated).toBe(0)
  })

  it('never picks excluded settings, e.g. ones that failed probation', () => {
    const cfg = cfgWith()
    const current = paramsFromConfig(cfg)
    const records = momentumMarket(600)
    const first = searchStrategies(records, cfg, current, OPTS, 0)
    const banned = paramsKey(first.best!.params)
    const second = searchStrategies(records, cfg, current, { ...OPTS, exclude: [banned] }, 0)
    expect(second.best && paramsKey(second.best.params)).not.toBe(banned)
    expect(second.finalists.every((f) => paramsKey(f.params) !== banned)).toBe(true)
  }, HEAVY_MS)

  it('stops at its time budget and still reports', () => {
    const cfg = cfgWith()
    const r = searchStrategies(momentumMarket(600), cfg, paramsFromConfig(cfg), { ...OPTS, budgetMs: 0 }, 0)
    expect(['found', 'none']).toContain(r.decision)
    expect(r.evaluated).toBeLessThan(5)
  })
})
