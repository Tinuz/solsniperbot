import { type Config, solToLamports } from '../config.js'

/**
 * The only settings the autotuner may change: which launches to buy
 * (filters) and when to sell (exits). Everything that decides how much money
 * is at risk (trade size, reserve, tips, slippage, risk limits, survival) is
 * deliberately out of its reach.
 */
export interface TunableParams {
  takeProfit: { gainPct: number; sellPct: number }[]
  stopLossPct: number
  trailingStopPct: number
  trailingArmPct: number
  maxHoldSec: number
  staleSec: number
  devBuyMinSol: number
  devBuyMaxSol: number
  devMaxSupplyPct: number
  maxEntryMcapSol: number
  creatorMaxLaunches: number
}

export type ScalarKey = Exclude<keyof TunableParams, 'takeProfit'>

/** Absolute limits no tuned value may leave. */
export const BOUNDS: Record<ScalarKey, [number, number]> = {
  stopLossPct: [10, 60],
  trailingStopPct: [0, 50],
  trailingArmPct: [10, 300],
  maxHoldSec: [30, 1_800],
  staleSec: [10, 600],
  devBuyMinSol: [0, 3],
  devBuyMaxSol: [0.2, 20],
  devMaxSupplyPct: [1, 30],
  maxEntryMcapSol: [30, 200],
  creatorMaxLaunches: [1, 10],
}
export const TP_GAIN_BOUNDS: [number, number] = [15, 500]
export const TP_SELL_BOUNDS: [number, number] = [25, 100]

/**
 * How far one adoption may move a setting from where it started, so the
 * strategy evolves in small, individually validated steps.
 */
export const STEP_LIMITS: Record<ScalarKey, { abs?: number; factor?: number }> = {
  stopLossPct: { abs: 10 },
  trailingStopPct: { abs: 10 },
  trailingArmPct: { abs: 40 },
  maxHoldSec: { factor: 2 },
  staleSec: { factor: 2 },
  devBuyMinSol: { abs: 0.5 },
  devBuyMaxSol: { factor: 2 },
  devMaxSupplyPct: { factor: 2 },
  maxEntryMcapSol: { factor: 1.5 },
  creatorMaxLaunches: { abs: 2 },
}
const TP_STEP_FACTOR = 2

export const ENV_NAMES: Record<keyof TunableParams, string> = {
  takeProfit: 'TAKE_PROFIT',
  stopLossPct: 'STOP_LOSS_PCT',
  trailingStopPct: 'TRAILING_STOP_PCT',
  trailingArmPct: 'TRAILING_ARM_PCT',
  maxHoldSec: 'MAX_HOLD_SECONDS',
  staleSec: 'STALE_SECONDS',
  devBuyMinSol: 'DEV_BUY_MIN_SOL',
  devBuyMaxSol: 'DEV_BUY_MAX_SOL',
  devMaxSupplyPct: 'DEV_MAX_SUPPLY_PCT',
  maxEntryMcapSol: 'MAX_ENTRY_MCAP_SOL',
  creatorMaxLaunches: 'CREATOR_MAX_LAUNCHES',
}

const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d

export function paramsFromConfig(cfg: Config): TunableParams {
  return {
    takeProfit: cfg.exits.takeProfit.map((t) => ({ ...t })),
    stopLossPct: cfg.exits.stopLossPct,
    trailingStopPct: cfg.exits.trailingStopPct,
    trailingArmPct: cfg.exits.trailingArmPct,
    maxHoldSec: cfg.exits.maxHoldMs / 1000,
    staleSec: cfg.exits.staleMs / 1000,
    devBuyMinSol: Number(cfg.filters.devBuyMinLamports) / 1e9,
    devBuyMaxSol: Number(cfg.filters.devBuyMaxLamports) / 1e9,
    devMaxSupplyPct: cfg.filters.devMaxSupplyPct,
    maxEntryMcapSol: Number(cfg.filters.maxEntryMcapLamports) / 1e9,
    creatorMaxLaunches: cfg.filters.creatorMaxLaunches,
  }
}

/** A copy of `cfg` with `p` applied (the live config is left untouched). */
export function withParams(cfg: Config, p: TunableParams): Config {
  return {
    ...cfg,
    exits: {
      ...cfg.exits,
      takeProfit: p.takeProfit.map((t) => ({ ...t })),
      stopLossPct: p.stopLossPct,
      trailingStopPct: p.trailingStopPct,
      trailingArmPct: p.trailingArmPct,
      maxHoldMs: Math.round(p.maxHoldSec * 1000),
      staleMs: Math.round(p.staleSec * 1000),
    },
    filters: {
      ...cfg.filters,
      devBuyMinLamports: solToLamports(p.devBuyMinSol),
      devBuyMaxLamports: solToLamports(p.devBuyMaxSol),
      devMaxSupplyPct: p.devMaxSupplyPct,
      maxEntryMcapLamports: solToLamports(p.maxEntryMcapSol),
      creatorMaxLaunches: p.creatorMaxLaunches,
    },
  }
}

/**
 * Applies `p` to the running bot in place. Filters and exits are read from
 * `cfg` on every decision, so this takes effect on the next launch/trade.
 */
export function applyParams(cfg: Config, p: TunableParams): void {
  const next = withParams(cfg, p)
  Object.assign(cfg.exits, next.exits)
  Object.assign(cfg.filters, next.filters)
}

export const tpToString = (tp: TunableParams['takeProfit']) =>
  tp.length ? tp.map((t) => `${round(t.gainPct, 1)}:${round(t.sellPct, 1)}`).join(',') : '0'

export function toEnv(p: TunableParams): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of Object.keys(ENV_NAMES) as (keyof TunableParams)[]) {
    out[ENV_NAMES[key]] = key === 'takeProfit' ? tpToString(p.takeProfit) : String(round(p[key]))
  }
  return out
}

export interface ParamChange {
  key: keyof TunableParams
  env: string
  from: string
  to: string
}

export function diffParams(a: TunableParams, b: TunableParams): ParamChange[] {
  const ea = toEnv(a)
  const eb = toEnv(b)
  const out: ParamChange[] = []
  for (const key of Object.keys(ENV_NAMES) as (keyof TunableParams)[]) {
    const env = ENV_NAMES[key]
    if (ea[env] !== eb[env]) out.push({ key, env, from: ea[env]!, to: eb[env]! })
  }
  return out
}

/** True when `p` is inside the absolute bounds and within one step of `origin`. */
export function withinLimits(p: TunableParams, origin: TunableParams): boolean {
  for (const key of Object.keys(BOUNDS) as ScalarKey[]) {
    const [lo, hi] = BOUNDS[key]
    const v = p[key]
    const o = origin[key]
    // An out-of-bounds .env value may stay where the user put it, but the tuner never moves outside.
    if ((v < lo || v > hi) && v !== o) return false
    const step = STEP_LIMITS[key]
    if (step.abs !== undefined && Math.abs(v - o) > step.abs + 1e-9) return false
    if (step.factor !== undefined && o > 0 && (v > o * step.factor + 1e-9 || v < o / step.factor - 1e-9)) return false
  }
  if (p.takeProfit.length !== origin.takeProfit.length && p.takeProfit.length > 2) return false
  for (const [i, t] of p.takeProfit.entries()) {
    const o = origin.takeProfit[Math.min(i, origin.takeProfit.length - 1)]
    const unchanged = o && t.gainPct === o.gainPct && t.sellPct === o.sellPct
    if (!unchanged) {
      if (t.gainPct < TP_GAIN_BOUNDS[0] || t.gainPct > TP_GAIN_BOUNDS[1]) return false
      if (t.sellPct < TP_SELL_BOUNDS[0] || t.sellPct > TP_SELL_BOUNDS[1]) return false
    }
    if (o && (t.gainPct > o.gainPct * TP_STEP_FACTOR + 1e-9 || t.gainPct < o.gainPct / TP_STEP_FACTOR - 1e-9)) return false
  }
  for (let i = 1; i < p.takeProfit.length; i++) if (p.takeProfit[i]!.gainPct <= p.takeProfit[i - 1]!.gainPct) return false
  return true
}

/**
 * Candidate values for one group of settings, around the current value.
 * The search tries these one group at a time.
 */
export function neighbors(p: TunableParams): { group: string; params: TunableParams }[] {
  const out: { group: string; params: TunableParams }[] = []
  const set = (group: string, patch: Partial<TunableParams>) => out.push({ group, params: { ...p, ...patch } })
  const scale = (v: number, fs: number[], d = 3) => fs.map((f) => round(v * f, d))

  for (const d of [-10, -5, 5, 10]) set('stop loss', { stopLossPct: p.stopLossPct + d })
  const trails = p.trailingStopPct === 0 ? [10, 15, 20] : [0, p.trailingStopPct - 5, p.trailingStopPct + 5, p.trailingStopPct + 10]
  for (const t of trails.filter((x) => x >= 0)) {
    for (const a of [p.trailingArmPct, p.trailingArmPct - 20, p.trailingArmPct + 20].filter((x) => x > 0)) {
      set('trailing stop', { trailingStopPct: t, trailingArmPct: a })
    }
  }
  for (const v of scale(p.maxHoldSec, [0.5, 0.75, 1.5, 2], 0)) set('max hold', { maxHoldSec: v })
  for (const v of scale(p.staleSec, [0.5, 0.75, 1.5, 2], 0)) set('stale exit', { staleSec: v })
  if (p.takeProfit.length) {
    for (const f of [0.6, 0.8, 1.25, 1.6]) {
      set('take profit', { takeProfit: p.takeProfit.map((t) => ({ gainPct: round(t.gainPct * f, 1), sellPct: t.sellPct })) })
    }
    const first = p.takeProfit[0]!
    if (p.takeProfit.length > 1) set('take profit', { takeProfit: [{ gainPct: first.gainPct, sellPct: 100 }] })
    for (const d of [-25, 25]) {
      if (p.takeProfit.length > 1) {
        const s = Math.max(TP_SELL_BOUNDS[0], Math.min(75, first.sellPct + d))
        set('take profit', { takeProfit: [{ gainPct: first.gainPct, sellPct: s }, ...p.takeProfit.slice(1)] })
      }
    }
  }
  for (const v of [0, p.devBuyMinSol + 0.1, p.devBuyMinSol + 0.25, round(p.devBuyMinSol / 2)]) set('dev buy min', { devBuyMinSol: round(v) })
  for (const v of scale(p.devBuyMaxSol, [0.5, 0.75, 1.5, 2])) set('dev buy max', { devBuyMaxSol: v })
  for (const v of scale(p.devMaxSupplyPct, [0.5, 0.75, 1.5, 2], 1)) set('dev supply', { devMaxSupplyPct: v })
  for (const v of scale(p.maxEntryMcapSol, [0.75, 0.9, 1.1, 1.5], 1)) set('entry mcap', { maxEntryMcapSol: v })
  for (const d of [-2, -1, 1, 2]) set('creator launches', { creatorMaxLaunches: p.creatorMaxLaunches + d })
  return out
}

export const paramsKey = (p: TunableParams) => JSON.stringify(toEnv(p))
