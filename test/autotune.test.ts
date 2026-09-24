import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pino } from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { AutoTuner } from '../src/learning/autotune.js'
import { loadRecords } from '../src/learning/dataset.js'
import type { LaunchRecord } from '../src/learning/record.js'
import {
  type TunableParams,
  applyParams,
  neighbors,
  paramsFromConfig,
  paramsKey,
  toEnv,
  withParams,
  withinLimits,
} from '../src/learning/tunable.js'
import { Evaluator, evaluateEdge, evaluateProbation, proposeTuning } from '../src/learning/tuner.js'
import { dataset, momentumMarket, pumpThenFade, slowRug, smallPump } from './records.js'

const log = pino({ level: 'silent' })
const START = 1_750_000_000_000
const HOUR = 3_600_000
const BASE_ENV = { DRY_RUN: 'true', RPC_URL: 'https://example.com', RECORD_LAUNCHES: 'true', ENTRY_MODE: 'instant' }
const OPTS = { minLaunches: 200, minHours: 10, minTrainTrades: 30, minTestTrades: 12, minEdgePct: 1, maxChanges: 3 }
const cfgWith = (over: Record<string, string> = {}) => loadConfig({ ...BASE_ENV, ...over })

describe('tunable settings', () => {
  const cfg = cfgWith()
  const current = paramsFromConfig(cfg)

  it('round-trips through .env: every suggestion can be pasted into .env as is', () => {
    const momentum = paramsFromConfig(cfgWith({ ENTRY_MODE: 'momentum' }))
    const candidates = [current, momentum, ...[current, momentum].flatMap((o) => neighbors(o).map((n) => n.params).filter((p) => withinLimits(p, o)))]
    expect(candidates.length).toBeGreaterThan(80)
    expect(candidates.some((p) => p.entryMode === 'momentum' && p.momentumMinBuyers !== momentum.momentumMinBuyers)).toBe(true)
    expect(candidates.some((p) => p.exitOnDevSell !== current.exitOnDevSell)).toBe(true)
    for (const p of candidates) {
      const parsed = paramsFromConfig(cfgWith(toEnv(p)))
      expect(paramsKey(parsed)).toBe(paramsKey(p))
    }
  })

  it('enforces absolute bounds and per-adoption step limits', () => {
    const at = (patch: Partial<TunableParams>, origin: Partial<TunableParams> = {}) =>
      withinLimits({ ...current, ...patch }, { ...current, ...origin })
    expect(at({ stopLossPct: 35 })).toBe(true) // 25 → 35: one step of 10
    expect(at({ stopLossPct: 36 })).toBe(false) // more than one step
    expect(at({ stopLossPct: 9 }, { stopLossPct: 15 })).toBe(false) // below the floor of 10
    expect(at({ stopLossPct: 80 }, { stopLossPct: 80 })).toBe(true) // user's own out-of-range value may stay
    expect(at({ stopLossPct: 70 }, { stopLossPct: 80 })).toBe(false) // but the tuner never moves outside
    expect(at({ maxHoldSec: 360 })).toBe(true) // 180 → 360: factor 2
    expect(at({ maxHoldSec: 361 })).toBe(false)
    expect(at({ maxHoldSec: 89 })).toBe(false)
    expect(at({ creatorMaxLaunches: 5 })).toBe(false) // 2 → 5: more than ±2
    expect(at({ maxEntryMcapSol: 250 }, { maxEntryMcapSol: 180 })).toBe(false) // above 200
    expect(at({ takeProfit: [{ gainPct: 120, sellPct: 50 }, { gainPct: 150, sellPct: 100 }] })).toBe(true)
    expect(at({ takeProfit: [{ gainPct: 121, sellPct: 50 }, { gainPct: 150, sellPct: 100 }] })).toBe(false) // more than 2x
    expect(at({ takeProfit: [{ gainPct: 60, sellPct: 50 }, { gainPct: 60, sellPct: 100 }] })).toBe(false) // tiers must rise
    expect(at({ takeProfit: [{ gainPct: 60, sellPct: 10 }, { gainPct: 150, sellPct: 100 }] })).toBe(false) // sells too little
    expect(at({ momentumMinNetBuySol: 1 })).toBe(true) // 2 → 1: factor 2
    expect(at({ momentumMinNetBuySol: 0.9 })).toBe(false)
    expect(at({ momentumMinBuyers: 10 })).toBe(false) // 6 → 10: more than ±3
    expect(at({ momentumMinAgeMs: 3_000, momentumMaxAgeMs: 3_000 })).toBe(false) // window must stay open
    expect(at({ entryMode: 'momentum', exitOnDevSell: false })).toBe(true) // switches are single steps
  })

  it('can only reach entry, filters and exits, never trade size, fees or risk limits', () => {
    for (const { params } of neighbors(current)) {
      const c = withParams(cfg, params)
      expect(c.buyLamports).toBe(cfg.buyLamports)
      expect(c.risk).toBe(cfg.risk)
      expect(c.survival).toBe(cfg.survival)
      expect(c.buyTipLamports).toBe(cfg.buyTipLamports)
      expect(c.buySlippageBps).toBe(cfg.buySlippageBps)
      expect(c.momentum.minAgeMs).toBeLessThan(c.momentum.maxAgeMs)
      expect(c.exits.sellSlippageBps).toBe(cfg.exits.sellSlippageBps)
      expect(c.filters.creatorBlocklist).toBe(cfg.filters.creatorBlocklist)
    }
  })

  it('applies to the running config in place', () => {
    const live = cfgWith()
    const exits = live.exits
    applyParams(live, { ...current, stopLossPct: 30, maxHoldSec: 240, devBuyMinSol: 0.25 })
    expect(live.exits).toBe(exits)
    expect(live.exits.stopLossPct).toBe(30)
    expect(live.exits.maxHoldMs).toBe(240_000)
    expect(live.filters.devBuyMinLamports).toBe(250_000_000n)
    expect(live.buyLamports).toBe(cfg.buyLamports)
  })
})

describe('proposeTuning', () => {
  const cfg = cfgWith()
  const current = paramsFromConfig(cfg)

  it('adopts a nearby setting that also wins on the held-out launches', () => {
    const r = proposeTuning(dataset(600), cfg, current, OPTS, 0)
    expect(r.decision).toBe('adopt')
    expect(r.gates.every((g) => g.pass)).toBe(true)
    expect(r.gates).toHaveLength(7)
    expect(r.changes.length).toBeGreaterThan(0)
    expect(r.changes.length).toBeLessThanOrEqual(OPTS.maxChanges)
    expect(withinLimits(r.candidate!, current)).toBe(true)
    expect(r.metrics!.candidate!.test.totalPnlLamports).toBeGreaterThan(r.metrics!.current.test.totalPnlLamports)
  })

  it('changes at most AUTOTUNE_MAX_CHANGES settings', () => {
    const r = proposeTuning(dataset(600, { seed: 3 }), cfg, current, { ...OPTS, maxChanges: 1 }, 0)
    expect(r.changes.length).toBeLessThanOrEqual(1)
  })

  it('rejects settings that only won on the past (regime change)', () => {
    // The search sees a pump-heavy market; the newest launches are all rugs.
    const past = dataset(420, { pumpShare: 0.9 })
    const now = Array.from({ length: 180 }, (_, i) => slowRug(START + (420 + i) * 300_000))
    const r = proposeTuning([...past, ...now], cfg, current, OPTS, 0)
    expect(r.decision).toBe('reject')
    const failed = r.gates.filter((g) => !g.pass).map((g) => g.name)
    expect(failed).toContain('wins out of sample')
    expect(failed).toContain('profitable out of sample')
    expect(failed).toContain('not one lucky trade')
  })

  it('switches to momentum entry when waiting is what wins out of sample', () => {
    const r = proposeTuning(momentumMarket(600), cfg, current, OPTS, 0)
    expect(r.decision).toBe('adopt')
    expect(r.changes.find((c) => c.env === 'ENTRY_MODE')).toMatchObject({ from: 'instant', to: 'momentum' })
    expect(r.candidate!.entryMode).toBe('momentum')
  })

  it('waits for enough data', () => {
    const r = proposeTuning(dataset(100), cfg, current, OPTS, 0)
    expect(r.decision).toBe('insufficient-data')
    expect(r.candidate).toBeUndefined()
    const short = proposeTuning(dataset(300, { spacingMs: 60_000 }), cfg, current, OPTS, 0)
    expect(short.decision).toBe('insufficient-data') // 300 launches but only 5 hours
  })
})

describe('Evaluator', () => {
  it('re-replays when the entry mcap cap changes in momentum mode', () => {
    // The cap is checked again at the moment of a momentum entry, not only at detection.
    const cfg = cfgWith()
    const e = new Evaluator(momentumMarket(200), cfg)
    const m: TunableParams = { ...paramsFromConfig(cfg), entryMode: 'momentum' }
    expect(e.summary(m).trades).toBeGreaterThan(20)
    expect(e.summary({ ...m, maxEntryMcapSol: 34 }).trades).toBe(0)
  })

  it('respects MAX_OPEN_POSITIONS like the live bot', () => {
    const recs = dataset(40, { spacingMs: 5_000, pumpShare: 1 })
    const one = new Evaluator(recs, cfgWith({ MAX_OPEN_POSITIONS: '1' })).summary(paramsFromConfig(cfgWith()))
    const many = new Evaluator(recs, cfgWith({ MAX_OPEN_POSITIONS: '50' })).summary(paramsFromConfig(cfgWith()))
    expect(many.trades).toBe(40)
    expect(one.trades).toBeLessThan(many.trades)
    // Each trade holds ~40s and a launch arrives every 5s: one slot takes roughly every 9th.
    expect(one.trades).toBeLessThanOrEqual(Math.ceil((40 * 5) / 40) + 1)
  })
})

describe('evaluateProbation', () => {
  const cfg = cfgWith()
  const previous = paramsFromConfig(cfg)
  const adopted: TunableParams = { ...previous, takeProfit: [{ gainPct: 75, sellPct: 100 }] }
  const since = START
  const after = (make: (t: number) => LaunchRecord, n: number) => Array.from({ length: n }, (_, i) => make(since + (i + 1) * 300_000))

  it('stays pending until enough trades happened after the adoption', () => {
    const old = dataset(100, { start: START - 100 * 300_000 }) // before adoption: ignored
    const r = evaluateProbation([...old, ...after(pumpThenFade, 10)], cfg, adopted, previous, since, 20)
    expect(r.status).toBe('pending')
    expect(r.trades).toBe(10)
  })

  it('passes when the new settings do at least as well', () => {
    const r = evaluateProbation(after(pumpThenFade, 30), cfg, adopted, previous, since, 20)
    expect(r.status).toBe('passed')
    expect(r.newPnlLamports).toBeGreaterThan(r.oldPnlLamports)
  })

  it('fails when the new settings do worse on new launches', () => {
    const r = evaluateProbation(after(smallPump, 30), cfg, adopted, previous, since, 20)
    expect(r.status).toBe('failed')
    expect(r.newPnlLamports).toBeLessThan(r.oldPnlLamports)
  })
})

describe('evaluateEdge', () => {
  const cfg = cfgWith()
  const current = paramsFromConfig(cfg)

  it('needs enough data before anything counts', () => {
    const e = evaluateEdge(dataset(100), cfg, current, OPTS, 0)
    expect(e.status).toBe('insufficient-data')
    expect(e.reason).toMatch(/^collecting data/)
  })

  it('is not proven when the settings lose on recent launches', () => {
    const e = evaluateEdge(dataset(600, { pumpShare: 0 }), cfg, current, OPTS, 0)
    expect(e.status).toBe('unproven')
    expect(e.gates.find((g) => g.name === 'makes money')?.pass).toBe(false)
    expect(e.recent!.totalPnlLamports).toBeLessThan(0)
  })

  it('is proven when the settings make money on recent launches', () => {
    const e = evaluateEdge(dataset(600), cfg, current, OPTS, 0)
    expect(e.status).toBe('proven')
    expect(e.gates.every((g) => g.pass)).toBe(true)
    expect(e.settingsKey).toBe(paramsKey(current))
  })
})

describe('AutoTuner', () => {
  const dirs: string[] = []
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
  })

  async function setup(over: Record<string, string> = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'autotune-'))
    dirs.push(dir)
    const env = {
      ...BASE_ENV,
      DATA_DIR: dir,
      AUTOTUNE_MIN_LAUNCHES: '200',
      AUTOTUNE_MIN_HOURS: '10',
      AUTOTUNE_MIN_TRADES: '30',
      AUTOTUNE_PROBATION_TRADES: '20',
      AUTOTUNE_DAYS: '30',
      ...over,
    }
    await writeRecords(dir, dataset(600))
    return { dir, env }
  }

  async function writeRecords(dir: string, recs: LaunchRecord[]) {
    await mkdir(join(dir, 'launches'), { recursive: true })
    const byDay = new Map<string, string>()
    for (const r of recs) {
      const day = new Date(r.t).toISOString().slice(0, 10)
      byDay.set(day, `${byDay.get(day) ?? ''}${JSON.stringify(r)}\n`)
    }
    for (const [day, text] of byDay) await writeFile(join(dir, 'launches', `${day}.jsonl`), text, { flag: 'a' })
  }

  function tuner(env: Record<string, string>, clock: { now: number }, inline = true) {
    const cfg = loadConfig(env)
    const t = new AutoTuner(cfg, log, { inline, now: () => clock.now })
    const notices: string[] = []
    t.on('notice', (level, message) => notices.push(`${level}: ${message}`))
    return { cfg, t, notices }
  }

  it('adopts in paper mode, survives a restart, and rolls back a failed probation', async () => {
    const { dir, env } = await setup()
    const clock = { now: START + 51 * HOUR }
    const a = tuner(env, clock)
    await a.t.load()
    const before = paramsFromConfig(a.cfg)

    const first = await a.t.run()
    expect(first.decision).toBe('adopt')
    const adopted = paramsFromConfig(a.cfg)
    expect(paramsKey(adopted)).not.toBe(paramsKey(before))
    expect(a.t.status().probation?.changes).toEqual(first.changes)
    expect(a.t.status().overrides).toEqual(first.changes)
    expect(a.notices.some((n) => n.startsWith('info: autotune adopted'))).toBe(true)
    expect(await readFile(join(dir, 'tuning', 'report.md'), 'utf8')).toContain('## Decision: ADOPT')
    expect(await readFile(join(dir, 'tuning', 'history.jsonl'), 'utf8')).toContain('"type":"adopt"')

    // Restart with the same .env: the adopted settings come back before trading starts.
    const b = tuner(env, clock)
    expect(paramsKey(paramsFromConfig(b.cfg))).toBe(paramsKey(before))
    await b.t.load()
    expect(paramsKey(paramsFromConfig(b.cfg))).toBe(paramsKey(adopted))

    // Nothing new recorded yet: probation stays pending and no new search runs.
    clock.now += HOUR
    const pending = await b.t.run()
    expect(pending.decision).toBe('skipped')
    expect(pending.probation?.status).toBe('pending')

    // New launches on which the adopted settings do worse: roll back.
    await writeRecords(dir, Array.from({ length: 30 }, (_, i) => smallPump(START + 51 * HOUR + (i + 1) * 60_000)))
    clock.now += HOUR
    const rolled = await b.t.run()
    expect(rolled.probation?.status).toBe('failed')
    expect(paramsKey(paramsFromConfig(b.cfg))).toBe(paramsKey(before))
    const s = b.t.status()
    expect(s.probation).toBeNull()
    expect(s.overrides).toEqual([])
    expect(s.cooldownUntil).toBe(clock.now + 24 * HOUR)
    expect(s.adoptions[0]!.status).toBe('rolled-back')
    expect(b.notices.some((n) => n.startsWith('warn: autotune: rolled back'))).toBe(true)

    // Cooling down: no search.
    clock.now += HOUR
    const cooling = await b.t.run()
    expect(cooling.decision).toBe('skipped')
    expect(cooling.reason).toMatch(/cooling down/)

    // After the cooldown it searches again, skipping what just failed.
    clock.now += 24 * HOUR
    const again = await b.t.run()
    expect(again.decision).not.toBe('skipped')
    expect(again.changes.map((c) => c.to)).not.toContain(first.changes[0]!.to)
    expect(paramsKey(paramsFromConfig(b.cfg))).not.toBe(paramsKey(adopted))
  })

  it('drops tuned overrides when the .env settings change', async () => {
    const { env } = await setup()
    const clock = { now: START + 51 * HOUR }
    const a = tuner(env, clock)
    await a.t.load()
    expect((await a.t.run()).decision).toBe('adopt')

    const changed = { ...env, STOP_LOSS_PCT: '30' }
    const b = tuner(changed, clock)
    await b.t.load()
    expect(paramsKey(paramsFromConfig(b.cfg))).toBe(paramsKey(paramsFromConfig(loadConfig(changed))))
    expect(b.t.status().overrides).toEqual([])
    expect(b.t.status().probation).toBeNull()
  })

  it('reverts to the .env settings by hand and pauses', async () => {
    const { env } = await setup()
    const clock = { now: START + 51 * HOUR }
    const a = tuner(env, clock)
    await a.t.load()
    const before = paramsKey(paramsFromConfig(a.cfg))
    const run = await a.t.run()
    expect(run.decision).toBe('adopt')
    const undone = await a.t.revert()
    expect(undone.map((c) => c.env)).toEqual(run.changes.map((c) => c.env))
    expect(paramsKey(paramsFromConfig(a.cfg))).toBe(before)
    expect(a.t.status().adoptions[0]!.status).toBe('reverted')
    expect(a.t.status().cooldownUntil).not.toBeNull()
  })

  it('only suggests in suggest mode', async () => {
    const { env } = await setup({ AUTOTUNE: 'suggest' })
    const clock = { now: START + 51 * HOUR }
    const a = tuner(env, clock)
    await a.t.load()
    const before = paramsKey(paramsFromConfig(a.cfg))
    const run = await a.t.run()
    expect(run.decision).toBe('adopt')
    expect(paramsKey(paramsFromConfig(a.cfg))).toBe(before)
    const s = a.t.status()
    expect(s.adopts).toBe(false)
    expect(s.suggestion?.changes).toEqual(run.changes)
    expect(s.overrides).toEqual([])
    await expect(a.t.revert()).rejects.toThrow(/only tuned automatically in paper mode/)
  })

  it('samples large recordings evenly over the whole period', async () => {
    const { dir } = await setup()
    const all = await loadRecords(dir)
    const sample = await loadRecords(dir, { max: 150 })
    expect(all).toHaveLength(600)
    expect(sample.length).toBeGreaterThanOrEqual(149)
    expect(sample.length).toBeLessThanOrEqual(151)
    // The sample spans the same period, so the data gate and time split still see it all.
    expect(sample[0]!.t).toBe(all[0]!.t)
    expect(all.at(-1)!.t - sample.at(-1)!.t).toBeLessThanOrEqual(4 * 300_000)
  })

  it('only allows trading while the settings in effect have a proven edge', async () => {
    const { dir, env } = await setup({ AUTOTUNE: 'off', REQUIRE_EDGE: 'true' })
    const clock = { now: START + 51 * HOUR }
    const a = tuner(env, clock)
    await a.t.load()
    expect(a.t.tradingGate()).toMatchObject({ allowed: false, reason: expect.stringMatching(/checking/) })

    const run = await a.t.run()
    expect(run.decision).toBe('skipped')
    expect(run.reason).toMatch(/edge check only/)
    expect(a.t.tradingGate().allowed).toBe(true)
    expect(a.t.status().edge).toMatchObject({ required: true, allowed: true, status: 'proven' })
    expect(a.notices.some((n) => n.startsWith('info: edge proven'))).toBe(true)
    expect(a.t.status().last).toBeNull() // an edge check is not a tuning decision

    // A proof goes stale if checks stop.
    clock.now += 4 * HOUR
    expect(a.t.tradingGate()).toEqual({ allowed: false, reason: 'edge check overdue' })
    clock.now -= 4 * HOUR

    // Restored after a restart.
    const b = tuner(env, clock)
    await b.t.load()
    expect(b.t.tradingGate().allowed).toBe(true)

    // The market turns: every new launch rugs. The edge is gone, buying stops.
    await writeRecords(dir, dataset(300, { pumpShare: 0, start: START + 50 * HOUR }))
    clock.now += HOUR
    await b.t.run()
    expect(b.t.tradingGate().allowed).toBe(false)
    expect(b.t.tradingGate().reason).toMatch(/no proven edge/)
    expect(b.notices.some((n) => n.startsWith('warn: buying paused, still recording'))).toBe(true)
  })

  it('searches with every check while data is still short', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'autotune-'))
    dirs.push(dir)
    await writeRecords(dir, dataset(100))
    const env = { ...BASE_ENV, DATA_DIR: dir, AUTOTUNE_MIN_LAUNCHES: '200', AUTOTUNE_MIN_HOURS: '10', AUTOTUNE_MIN_TRADES: '30', AUTOTUNE_DAYS: '30' }
    const clock = { now: START + 9 * HOUR }
    const a = tuner(env, clock)
    await a.t.load()
    expect((await a.t.run('schedule')).decision).toBe('insufficient-data')
    clock.now += HOUR
    expect((await a.t.run('schedule')).decision).toBe('insufficient-data') // not "next search in 6h"
    expect(a.t.tradingGate().reason).toMatch(/collecting data/)
    await a.t.stop()
  })

  it('keeps observing when nothing makes money', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'autotune-'))
    dirs.push(dir)
    await writeRecords(dir, dataset(600, { pumpShare: 0 }))
    const env = { ...BASE_ENV, DATA_DIR: dir, AUTOTUNE_MIN_LAUNCHES: '200', AUTOTUNE_MIN_HOURS: '10', AUTOTUNE_MIN_TRADES: '30', AUTOTUNE_DAYS: '30' }
    const a = tuner(env, { now: START + 51 * HOUR })
    await a.t.load()
    const run = await a.t.run()
    expect(run.decision).not.toBe('adopt')
    expect(a.t.tradingGate().allowed).toBe(false)
    expect(a.t.status().edge.status).toBe('unproven')
  })

  it('trades on adopted settings that proved themselves, and re-checks after a revert', async () => {
    const { env } = await setup()
    const clock = { now: START + 51 * HOUR }
    const a = tuner(env, clock)
    await a.t.load()
    expect((await a.t.run()).decision).toBe('adopt')
    // The edge that counts is the adopted settings' own.
    expect(a.t.status().edge.status).toBe('proven')
    expect(a.t.tradingGate().allowed).toBe(true)
    await a.t.revert()
    expect(a.t.tradingGate()).toMatchObject({ allowed: false, reason: expect.stringMatching(/checking/) })
    await a.t.run()
    expect(a.t.tradingGate().allowed).toBe(true) // the .env settings also make money on this data
  })

  it('runs the search in a worker thread', async () => {
    const { env } = await setup()
    const clock = { now: START + 51 * HOUR }
    const w = tuner(env, clock, false)
    await w.t.load()
    const current = paramsFromConfig(w.cfg)
    const run = await w.t.run()
    await w.t.stop()
    expect(run.records).toBe(600)
    expect(run.decision).toBe('adopt')
    // Same data and settings: the worker reaches the same result as an inline search.
    expect(run.changes).toEqual(proposeTuning(dataset(600), cfgWith(), current, OPTS, 0).changes)
  }, 30_000)
})

describe('autotune config', () => {
  it('requires a proven edge whenever launches are recorded', () => {
    expect(cfgWith().autotune.requireEdge).toBe(true)
    expect(cfgWith({ DRY_RUN: 'false', PRIVATE_KEY: '[1]' }).autotune.requireEdge).toBe(true)
    expect(cfgWith({ RECORD_LAUNCHES: 'false' }).autotune.requireEdge).toBe(false)
    expect(cfgWith({ REQUIRE_EDGE: 'false' }).autotune.requireEdge).toBe(false)
    expect(() => cfgWith({ REQUIRE_EDGE: 'true', RECORD_LAUNCHES: 'false' })).toThrow(/REQUIRE_EDGE needs RECORD_LAUNCHES/)
  })

  it('adopts automatically only in paper mode', () => {
    expect(cfgWith().autotune.mode).toBe('paper')
    expect(cfgWith({ DRY_RUN: 'false', PRIVATE_KEY: '[1]' }).autotune.mode).toBe('suggest')
    expect(cfgWith({ RECORD_LAUNCHES: 'false' }).autotune.mode).toBe('off')
    expect(() => cfgWith({ AUTOTUNE: 'paper', DRY_RUN: 'false', PRIVATE_KEY: '[1]' })).toThrow(/only works in paper mode/)
    expect(() => cfgWith({ AUTOTUNE: 'suggest', RECORD_LAUNCHES: 'false' })).toThrow(/needs RECORD_LAUNCHES/)
  })
})
