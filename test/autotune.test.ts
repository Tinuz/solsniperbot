import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pino } from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { AutoTuner, loadTunedParams } from '../src/learning/autotune.js'
import { loadRecords } from '../src/learning/dataset.js'
import type { LaunchRecord } from '../src/learning/record.js'
import {
  type TunableParams,
  applyParams,
  diffParams,
  neighbors,
  paramsFromConfig,
  paramsKey,
  toEnv,
  withParams,
  withinLimits,
} from '../src/learning/tunable.js'
import { Evaluator, evaluateEdge, evaluateProbation, proposeTuning } from '../src/learning/tuner.js'
import { dataset, momentumMarket, pumpThenFade, recordedUnder, slowRug, smallPump } from './records.js'

const log = pino({ level: 'silent' })
const START = 1_750_000_000_000
const HOUR = 3_600_000
const BASE_ENV = { DRY_RUN: 'true', RPC_URL: 'https://example.com', RECORD_LAUNCHES: 'true', ENTRY_MODE: 'instant' }
const OPTS = { minLaunches: 200, minHours: 10, minTrainTrades: 30, minTestTrades: 12, minEdgePct: 1, maxChanges: 3 }
const cfgWith = (over: Record<string, string> = {}) => loadConfig({ ...BASE_ENV, ...over })
/** Full strategy searches are CPU-bound: slower machines need more than the default limit. */
const HEAVY_MS = 90_000

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
    expect(at({ momentumMaxTopBuyerPct: 5 })).toBe(true) // off → on
    expect(at({ momentumMaxTopBuyerPct: 25 })).toBe(false) // on, but past the bound
    expect(at({ momentumMaxTopBuyerPct: 0 }, { momentumMaxTopBuyerPct: 5 })).toBe(true) // on → off
    expect(at({ momentumMaxTopBuyerPct: 11 }, { momentumMaxTopBuyerPct: 5 })).toBe(false) // more than 2x
    expect(at({ moonbagPct: 25 })).toBe(true) // moonbag off → on
    expect(at({ moonbagPct: 60 })).toBe(false) // past its bound
    expect(at({ moonbagPct: 25, moonbagSecurePct: 30 }, { moonbagPct: 25 })).toBe(false) // secured profit: ±10 per step
    expect(at({ moonbagPct: 25, moonbagTrailingPct: 80 }, { moonbagPct: 25, moonbagTrailingPct: 70 })).toBe(false) // past its bound
    expect(at({ moonbagTrailingPct: 90 })).toBe(true) // irrelevant while the moonbag is off
  })

  it('keys settings without a moonbag exactly as before moonbags existed', () => {
    expect(paramsKey(current)).not.toMatch(/MOONBAG/)
    expect(paramsKey({ ...current, moonbagSecurePct: 30 })).toBe(paramsKey(current)) // off: its settings don't matter
    const on = { ...current, moonbagPct: 25 }
    expect(paramsKey(on)).toMatch(/"MOONBAG_PCT":"25"/)
    expect(diffParams(current, on)).toEqual([{ key: 'moonbagPct', env: 'MOONBAG_PCT', from: '0', to: '25' }])
    expect(neighbors(current).some((n) => n.params.moonbagPct === 25)).toBe(true)
    expect(neighbors(on).some((n) => n.params.moonbagTrailingPct !== on.moonbagTrailingPct)).toBe(true)
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

  it('needs enough forward data before anything counts', () => {
    const e = evaluateEdge(recordedUnder(dataset(100), current), cfg, current, OPTS, 0)
    expect(e.status).toBe('insufficient-data')
    expect(e.reason).toMatch(/^collecting forward data: 30 launches/)
  })

  it('never counts launches recorded before the settings took effect, however profitable', () => {
    // The data a search picked the settings from: it can never prove them.
    const e = evaluateEdge(dataset(600), cfg, current, OPTS, 0)
    expect(e.status).toBe('insufficient-data')
    expect(e.reason).toMatch(/^collecting forward data: 0 launches/)
    // Recorded under other settings: not these settings' evidence either.
    const other = paramsFromConfig(cfgWith({ STOP_LOSS_PCT: '35' }))
    expect(evaluateEdge(recordedUnder(dataset(600), other), cfg, current, OPTS, 0).status).toBe('insufficient-data')
  })

  it('is not proven when the settings lose on launches recorded under them', () => {
    const e = evaluateEdge(recordedUnder(dataset(600, { pumpShare: 0 }), current), cfg, current, OPTS, 0)
    expect(e.status).toBe('unproven')
    expect(e.gates.find((g) => g.name === 'makes money')?.pass).toBe(false)
    expect(e.recent!.totalPnlLamports).toBeLessThan(0)
  })

  it('is proven when the settings make money on launches recorded under them', () => {
    const e = evaluateEdge(recordedUnder(dataset(600), current), cfg, current, OPTS, 0)
    expect(e.status).toBe('proven')
    expect(e.gates.every((g) => g.pass)).toBe(true)
    expect(e.settingsKey).toBe(paramsKey(current))
    expect(e.recent!.trades).toBeLessThan(200) // only the newest 30% counted
  })

  it('gives settings that hardly trade AUTOTUNE_MIN_HOURS in effect, counted over all loaded data, then calls them unproven', () => {
    const strictCfg = cfgWith({ ENTRY_MODE: 'momentum', MOMENTUM_MIN_BUYERS: '30', MOMENTUM_MIN_NET_BUY_SOL: '20' })
    const strict = paramsFromConfig(strictCfg)
    const o = { ...OPTS, minHours: 24 }
    // In effect for the last 15 hours only: no verdict yet.
    expect(evaluateEdge(recordedUnder(momentumMarket(600), strict), strictCfg, strict, o, 0).status).toBe('insufficient-data')
    // In effect for all 50 hours, though the window holds only the newest 15: unproven.
    const e = evaluateEdge(recordedUnder(momentumMarket(600), strict, 1), strictCfg, strict, o, 0)
    expect(e.status).toBe('unproven')
    expect(e.reason).toMatch(/enough trades/)
  })

  it('counts every launch since a given moment for a candidate picked then (shadow test)', () => {
    const records = dataset(600)
    const since = records[420]!.t
    expect(evaluateEdge(records, cfg, current, OPTS, 0, since).status).toBe('proven')
  })
})

describe('AutoTuner', () => {
  const dirs: string[] = []
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
  })

  /**
   * Recorded launches: the newest 30% under the .env settings, as the recorder
   * stamps them. Without the edge gate unless a test asks for it: these tests
   * are about adoption, probation and rollback.
   */
  async function setup(over: Record<string, string> = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'autotune-'))
    dirs.push(dir)
    const env = {
      ...BASE_ENV,
      REQUIRE_EDGE: 'false',
      DATA_DIR: dir,
      AUTOTUNE_MIN_LAUNCHES: '200',
      AUTOTUNE_MIN_HOURS: '10',
      AUTOTUNE_MIN_TRADES: '30',
      AUTOTUNE_PROBATION_TRADES: '20',
      AUTOTUNE_DAYS: '30',
      ...over,
    }
    await writeRecords(dir, recordedUnder(dataset(600), paramsFromConfig(loadConfig(env))))
    return { dir, env }
  }

  /** `n` launches every 3 minutes from `start`, recorded while `params` were in effect. */
  const launchesUnder = (params: TunableParams, n: number, start: number, make = pumpThenFade) =>
    recordedUnder(Array.from({ length: n }, (_, i) => make(start + (i + 1) * 180_000)), params, 1)

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

  it('restores tuned settings saved before moonbags existed', async () => {
    const { dir, env } = await setup()
    const clock = { now: START + 51 * HOUR }
    const a = tuner(env, clock)
    await a.t.load()
    const first = await a.t.run()
    expect(first.decision).toBe('adopt')
    // Strip the moonbag settings, as an older version saved them.
    const path = join(dir, 'tuning', 'state-paper.json')
    const strip = (p: Record<string, unknown>) => Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith('moonbag')))
    const saved = JSON.parse(await readFile(path, 'utf8'))
    saved.baseline = strip(saved.baseline)
    saved.active = strip(saved.active)
    saved.adoptions = saved.adoptions.map((x: { from: Record<string, unknown>; to: Record<string, unknown> }) => ({ ...x, from: strip(x.from), to: strip(x.to) }))
    await writeFile(path, JSON.stringify(saved))

    const b = tuner(env, clock)
    await b.t.load()
    expect(b.t.status().overrides).toEqual(first.changes)
    expect(b.cfg.exits.moonbag).toMatchObject({ pct: 0, securePct: 10, trailingPct: 40, maxHoldMs: 0 })
    expect((await loadTunedParams(loadConfig(env)))?.changes).toEqual(first.changes)
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
    await expect(a.t.revert()).rejects.toThrow(/only tuned automatically/)
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
    await writeRecords(dir, recordedUnder(dataset(300, { pumpShare: 0, start: START + 50 * HOUR }), paramsFromConfig(b.cfg), 1))
    clock.now += HOUR
    await b.t.run()
    expect(b.t.tradingGate().allowed).toBe(false)
    expect(b.t.tradingGate().reason).toMatch(/no proven edge/)
    expect(b.notices.some((n) => n.startsWith('warn: buying paused, still recording'))).toBe(true)
  })

  it('searches with every check while data is still short (without the edge gate)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'autotune-'))
    dirs.push(dir)
    await writeRecords(dir, dataset(100))
    const env = { ...BASE_ENV, DATA_DIR: dir, REQUIRE_EDGE: 'false', AUTOTUNE_MIN_LAUNCHES: '200', AUTOTUNE_MIN_HOURS: '10', AUTOTUNE_MIN_TRADES: '30', AUTOTUNE_DAYS: '30' }
    const clock = { now: START + 9 * HOUR }
    const a = tuner(env, clock)
    await a.t.load()
    expect((await a.t.run('schedule')).decision).toBe('insufficient-data')
    clock.now += HOUR
    expect((await a.t.run('schedule')).decision).toBe('insufficient-data') // not "next search in 6h"
    await a.t.stop()
  })

  it('never replaces settings that are still collecting their forward proof, so the gate can open', async () => {
    // Strict settings that never trade: unproven, so exploration adopts something that works.
    const strict = { ENTRY_MODE: 'momentum', MOMENTUM_MIN_BUYERS: '30', MOMENTUM_MIN_NET_BUY_SOL: '20', REQUIRE_EDGE: 'true' }
    const dir = await mkdtemp(join(tmpdir(), 'autotune-'))
    dirs.push(dir)
    const env = { ...BASE_ENV, ...strict, DATA_DIR: dir, AUTOTUNE_MIN_LAUNCHES: '200', AUTOTUNE_MIN_HOURS: '10', AUTOTUNE_MIN_TRADES: '30', AUTOTUNE_PROBATION_TRADES: '3', AUTOTUNE_DAYS: '30' }
    await writeRecords(dir, recordedUnder(momentumMarket(600), paramsFromConfig(loadConfig(env))))
    const clock = { now: START + 51 * HOUR }
    const a = tuner(env, clock)
    await a.t.load()
    expect((await a.t.run()).reason).toMatch(/^exploration/)
    const adopted = paramsFromConfig(a.cfg)
    expect(a.t.tradingGate().allowed).toBe(false)

    // Every cycle a search falls due, and new launches arrive under the adopted settings.
    let from = START + 51 * HOUR
    const reasons: string[] = []
    for (let cycle = 0; cycle < 3; cycle++) {
      await writeRecords(dir, recordedUnder(momentumMarket(30, from), adopted, 1))
      from += 30 * 300_000
      clock.now += 7 * HOUR
      reasons.push((await a.t.run('schedule')).reason)
      // Kept: replacing them would restart their forward clock.
      expect(paramsKey(paramsFromConfig(a.cfg))).toBe(paramsKey(adopted))
    }
    expect(reasons.some((r) => /^no search while the settings in effect collect their forward proof \(collecting forward data: \d+\/12 trades/.test(r))).toBe(true)
    expect(a.t.status().adoptions).toHaveLength(1)
    // 90 launches over seven hours under them, with enough trades, and they make money: trading starts.
    expect(a.t.status().edge.status).toBe('proven')
    expect(a.t.tradingGate().allowed).toBe(true)
  }, HEAVY_MS)

  it('shows why it does not search while the forward proof is being collected', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'autotune-'))
    dirs.push(dir)
    await writeRecords(dir, dataset(100))
    const env = { ...BASE_ENV, DATA_DIR: dir, AUTOTUNE_MIN_LAUNCHES: '200', AUTOTUNE_MIN_HOURS: '10', AUTOTUNE_MIN_TRADES: '30', AUTOTUNE_DAYS: '30' }
    const a = tuner(env, { now: START + 9 * HOUR })
    await a.t.load()
    const run = await a.t.run('schedule')
    expect(run.decision).toBe('skipped')
    expect(run.reason).toMatch(/^no search while the settings in effect collect their forward proof \(collecting forward data: 0 launches/)
    expect(a.t.tradingGate().reason).toMatch(/collecting forward data/)
    await a.t.stop()
  })

  it('keeps observing when nothing makes money', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'autotune-'))
    dirs.push(dir)
    const env = { ...BASE_ENV, DATA_DIR: dir, AUTOTUNE_MIN_LAUNCHES: '200', AUTOTUNE_MIN_HOURS: '10', AUTOTUNE_MIN_TRADES: '30', AUTOTUNE_DAYS: '30' }
    await writeRecords(dir, recordedUnder(dataset(600, { pumpShare: 0 }), paramsFromConfig(loadConfig(env))))
    const a = tuner(env, { now: START + 51 * HOUR })
    await a.t.load()
    const run = await a.t.run()
    expect(run.decision).not.toBe('adopt')
    expect(a.t.tradingGate().allowed).toBe(false)
    expect(a.t.status().edge.status).toBe('unproven')
  })

  it('shadow-tests a paper candidate while the settings in effect make money, so trading never stops', async () => {
    const { dir, env } = await setup({ REQUIRE_EDGE: 'true' })
    const clock = { now: START + 51 * HOUR }
    const a = tuner(env, clock)
    await a.t.load()
    const before = paramsFromConfig(a.cfg)
    const found = await a.t.run()
    expect(found.decision).toBe('adopt')
    expect(found.reason).toMatch(/shadow test started/)
    expect(paramsKey(paramsFromConfig(a.cfg))).toBe(paramsKey(before)) // still trading the proven settings
    expect(a.t.tradingGate().allowed).toBe(true)
    expect(a.notices.some((n) => /shadow-testing .* before trading it \(/.test(n))).toBe(true)

    // The candidate does better on the next launches: adopted, and the shadow test is its forward proof.
    await writeRecords(dir, launchesUnder(before, 80, clock.now))
    clock.now += 5 * HOUR
    expect((await a.t.run()).probation?.status).toBe('passed')
    expect(paramsKey(paramsFromConfig(a.cfg))).not.toBe(paramsKey(before))
    expect(a.t.status().edge).toMatchObject({ status: 'proven', allowed: true })
    expect(a.t.sizeFactor()).toBe(1) // paper: no reduced stake

    // The shadow start is kept as the start of its proof, across a restart too.
    const state = async () => JSON.parse(await readFile(join(dir, 'tuning', 'state-paper.json'), 'utf8'))
    const adopted = paramsFromConfig(a.cfg)
    expect((await state()).forwardSince).toEqual({ key: paramsKey(adopted), since: START + 51 * HOUR })
    const b = tuner(env, clock)
    await b.t.load()
    expect(paramsKey(paramsFromConfig(b.cfg))).toBe(paramsKey(adopted))
    await b.t.run()
    expect(b.t.tradingGate().allowed).toBe(true)

    // Back to the .env settings by hand: they need their own proof before trading again.
    await a.t.revert()
    expect((await state()).forwardSince).toBeUndefined()
    expect(a.t.tradingGate()).toMatchObject({ allowed: false, reason: expect.stringMatching(/checking/) })
    await a.t.run()
    expect(a.t.tradingGate().allowed).toBe(true) // recorded under them, and they make money
  })

  it('drops a shadow test when the .env settings change: its candidate never overwrites them', async () => {
    const { dir, env } = await setup({ REQUIRE_EDGE: 'true' })
    const clock = { now: START + 51 * HOUR }
    const a = tuner(env, clock)
    await a.t.load()
    expect((await a.t.run()).reason).toMatch(/shadow test started/)
    expect(a.t.status().shadow).not.toBeNull()

    // The owner edits .env and restarts while the shadow test runs.
    const edited = { ...env, STOP_LOSS_PCT: '35' }
    const b = tuner(edited, clock)
    await b.t.load()
    expect(b.t.status().shadow).toBeNull()
    await writeRecords(dir, launchesUnder(paramsFromConfig(b.cfg), 80, clock.now))
    clock.now += 5 * HOUR
    const run = await b.t.run()
    expect(run.probation).toBeUndefined() // no stale shadow verdict
    expect(b.cfg.exits.stopLossPct).toBe(35) // the owner's edit stands
  })

  it('live: shadow-tests a candidate first, then trades it at reduced size until probation passes', async () => {
    const { dir, env } = await setup({ AUTOTUNE: 'live', DRY_RUN: 'false', PRIVATE_KEY: '[1]', REQUIRE_EDGE: 'true' })
    const clock = { now: START + 51 * HOUR }
    const a = tuner(env, clock)
    await a.t.load()
    const before = paramsFromConfig(a.cfg)

    // Found and validated, but not traded: a shadow test on new launches comes first.
    const found = await a.t.run()
    expect(found.decision).toBe('adopt')
    expect(found.changes).toHaveLength(1) // live: one change at a time
    expect(found.reason).toMatch(/shadow test started/)
    expect(paramsKey(paramsFromConfig(a.cfg))).toBe(paramsKey(before))
    expect(a.t.status().shadow?.changes).toEqual(found.changes)
    expect(a.t.sizeFactor()).toBe(1)

    // New launches (recorded under the settings still in effect) on which the candidate does well: adopted live, at half size.
    await writeRecords(dir, launchesUnder(before, 80, clock.now))
    clock.now += 5 * HOUR
    const shadowed = await a.t.run()
    expect(shadowed.probation?.status).toBe('passed')
    expect(paramsKey(paramsFromConfig(a.cfg))).not.toBe(paramsKey(before))
    expect(a.t.status().shadow).toBeNull()
    expect(a.t.status().probation?.changes).toEqual(found.changes)
    expect(a.t.sizeFactor()).toBe(0.5)
    // Its own proof, from the launches since it was found, not the old settings'.
    expect(a.t.status().edge).toMatchObject({ status: 'proven', allowed: true })
    expect(a.notices.some((n) => /adopted .* after a shadow test .*trading at 50% size/.test(n))).toBe(true)

    // It keeps doing well on the next launches: probation passes, full size again, and
    // the shadow-test launches still count as its forward data.
    const adopted = paramsFromConfig(a.cfg)
    await writeRecords(dir, launchesUnder(adopted, 30, clock.now))
    clock.now += 2 * HOUR
    expect((await a.t.run()).probation?.status).toBe('passed')
    expect(a.t.sizeFactor()).toBe(1)
    expect(a.t.tradingGate().allowed).toBe(true)
  })

  it('live: a candidate that fails its shadow test is never traded', async () => {
    const { dir, env } = await setup({ AUTOTUNE: 'live', DRY_RUN: 'false', PRIVATE_KEY: '[1]', REQUIRE_EDGE: 'true' })
    const clock = { now: START + 51 * HOUR }
    const a = tuner(env, clock)
    await a.t.load()
    const before = paramsKey(paramsFromConfig(a.cfg))
    const found = await a.t.run()
    expect(a.t.status().shadow).not.toBeNull()

    await writeRecords(dir, Array.from({ length: 30 }, (_, i) => smallPump(clock.now + (i + 1) * 60_000)))
    clock.now += HOUR
    const shadowed = await a.t.run()
    expect(shadowed.probation?.status).toBe('failed')
    expect(paramsKey(paramsFromConfig(a.cfg))).toBe(before)
    expect(a.t.status().shadow).toBeNull()
    expect(a.t.status().adoptions).toHaveLength(0)
    expect(a.notices.some((n) => n.startsWith('warn: autotune: shadow test failed'))).toBe(true)
    // Not proposed again.
    const next = await a.t.run()
    expect(next.changes).not.toEqual(found.changes)
  })

  it('explores the whole range while observing, and adopts what holds up (paper)', async () => {
    // Settings so strict that no nearby step makes a single trade.
    const strict = { ENTRY_MODE: 'momentum', MOMENTUM_MIN_BUYERS: '30', MOMENTUM_MIN_NET_BUY_SOL: '20', REQUIRE_EDGE: 'true' }
    const dir = await mkdtemp(join(tmpdir(), 'autotune-'))
    dirs.push(dir)
    const env = { ...BASE_ENV, ...strict, DATA_DIR: dir, AUTOTUNE_MIN_LAUNCHES: '200', AUTOTUNE_MIN_HOURS: '10', AUTOTUNE_MIN_TRADES: '30', AUTOTUNE_DAYS: '30' }
    // Recorded under these settings long enough for a verdict: they never trade, so unproven.
    await writeRecords(dir, recordedUnder(momentumMarket(600), paramsFromConfig(loadConfig(env))))
    const a = tuner(env, { now: START + 51 * HOUR })
    await a.t.load()
    expect(a.t.tradingGate().allowed).toBe(false)
    const run = await a.t.run()
    expect(run.decision).toBe('adopt')
    expect(run.reason).toMatch(/^exploration: makes/)
    expect(run.exploration?.decision).toBe('found')
    // A jump no step limit would allow, taken because nothing was being traded on it.
    expect(a.cfg.momentum.minBuyers).toBeLessThan(27)
    expect(a.t.status().probation).not.toBeNull()
    // Found on the recorded data, so that data is no proof: it observes until launches under it are.
    expect(a.t.tradingGate().allowed).toBe(false)
    expect(a.notices.some((n) => /adopted .* after exploring/.test(n))).toBe(true)

    // Without the edge gate the bot might be trading, so it never jumps.
    const b = tuner({ ...env, REQUIRE_EDGE: 'false' }, { now: START + 51 * HOUR })
    await b.t.load()
    const nearby = await b.t.run()
    expect(nearby.exploration).toBeUndefined()
    expect(nearby.decision).not.toBe('adopt')
  }, HEAVY_MS)

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

  it('adopts in live mode only when asked explicitly, and never without the edge gate', () => {
    expect(cfgWith({ AUTOTUNE: 'live', DRY_RUN: 'false', PRIVATE_KEY: '[1]' }).autotune).toMatchObject({ mode: 'live', requireEdge: true, liveProbationSizePct: 50 })
    expect(() => cfgWith({ AUTOTUNE: 'live' })).toThrow(/AUTOTUNE=live is for live trading/)
    expect(() => cfgWith({ AUTOTUNE: 'live', DRY_RUN: 'false', PRIVATE_KEY: '[1]', REQUIRE_EDGE: 'false' })).toThrow(/needs REQUIRE_EDGE/)
  })

  it('adopts automatically only in paper mode', () => {
    expect(cfgWith().autotune.mode).toBe('paper')
    expect(cfgWith({ DRY_RUN: 'false', PRIVATE_KEY: '[1]' }).autotune.mode).toBe('suggest')
    expect(cfgWith({ RECORD_LAUNCHES: 'false' }).autotune.mode).toBe('off')
    expect(() => cfgWith({ AUTOTUNE: 'paper', DRY_RUN: 'false', PRIVATE_KEY: '[1]' })).toThrow(/only works in paper mode/)
    expect(() => cfgWith({ AUTOTUNE: 'suggest', RECORD_LAUNCHES: 'false' })).toThrow(/needs RECORD_LAUNCHES/)
  })
})
