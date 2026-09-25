import { createHash } from 'node:crypto'
import { type Config, solToLamports } from '../config.js'

/**
 * The only settings the autotuner may change: which launches to buy
 * (filters), when to buy them (entry), and when to sell (exits). Everything
 * that decides how much money is at risk (trade size, reserve, tips,
 * slippage, risk limits, survival) is deliberately out of its reach.
 */
export interface TunableParams {
  entryMode: 'instant' | 'momentum'
  momentumMinBuyers: number
  momentumMinNetBuySol: number
  momentumMaxSellRatio: number
  momentumMinAgeMs: number
  momentumMaxAgeMs: number
  /** 0 = off. */
  momentumMaxEarlyBuySol: number
  /** 0 = off. */
  momentumMaxTopBuyerPct: number
  takeProfit: { gainPct: number; sellPct: number }[]
  stopLossPct: number
  trailingStopPct: number
  trailingArmPct: number
  maxHoldSec: number
  staleSec: number
  exitOnDevSell: boolean
  devBuyMinSol: number
  devBuyMaxSol: number
  devMaxSupplyPct: number
  maxEntryMcapSol: number
  creatorMaxLaunches: number
}

export type ScalarKey = Exclude<keyof TunableParams, 'takeProfit' | 'entryMode' | 'exitOnDevSell'>

/** Absolute limits no tuned value may leave. */
export const BOUNDS: Record<ScalarKey, [number, number]> = {
  momentumMinBuyers: [1, 30],
  momentumMinNetBuySol: [0.05, 20],
  momentumMaxSellRatio: [0.05, 1.5],
  momentumMinAgeMs: [500, 10_000],
  momentumMaxAgeMs: [3_000, 60_000],
  momentumMaxEarlyBuySol: [0.2, 50],
  momentumMaxTopBuyerPct: [0.5, 20],
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
  momentumMinBuyers: { abs: 3 },
  momentumMinNetBuySol: { factor: 2 },
  momentumMaxSellRatio: { abs: 0.2 },
  momentumMinAgeMs: { factor: 2 },
  momentumMaxAgeMs: { factor: 2 },
  momentumMaxEarlyBuySol: { factor: 2 },
  momentumMaxTopBuyerPct: { factor: 2 },
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

/** Settings where 0 means "off": switching on (to any in-bounds value) or off counts as one step. */
const OPTIONAL: ReadonlySet<ScalarKey> = new Set(['momentumMaxEarlyBuySol', 'momentumMaxTopBuyerPct'])

export const ENV_NAMES: Record<keyof TunableParams, string> = {
  entryMode: 'ENTRY_MODE',
  momentumMinBuyers: 'MOMENTUM_MIN_BUYERS',
  momentumMinNetBuySol: 'MOMENTUM_MIN_NET_BUY_SOL',
  momentumMaxSellRatio: 'MOMENTUM_MAX_SELL_RATIO',
  momentumMinAgeMs: 'MOMENTUM_MIN_AGE_MS',
  momentumMaxAgeMs: 'MOMENTUM_MAX_AGE_MS',
  momentumMaxEarlyBuySol: 'MOMENTUM_MAX_EARLY_BUY_SOL',
  momentumMaxTopBuyerPct: 'MOMENTUM_MAX_TOP_BUYER_PCT',
  takeProfit: 'TAKE_PROFIT',
  stopLossPct: 'STOP_LOSS_PCT',
  trailingStopPct: 'TRAILING_STOP_PCT',
  trailingArmPct: 'TRAILING_ARM_PCT',
  maxHoldSec: 'MAX_HOLD_SECONDS',
  staleSec: 'STALE_SECONDS',
  exitOnDevSell: 'EXIT_ON_DEV_SELL',
  devBuyMinSol: 'DEV_BUY_MIN_SOL',
  devBuyMaxSol: 'DEV_BUY_MAX_SOL',
  devMaxSupplyPct: 'DEV_MAX_SUPPLY_PCT',
  maxEntryMcapSol: 'MAX_ENTRY_MCAP_SOL',
  creatorMaxLaunches: 'CREATOR_MAX_LAUNCHES',
}

const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d

export function paramsFromConfig(cfg: Config): TunableParams {
  return {
    entryMode: cfg.entryMode,
    momentumMinBuyers: cfg.momentum.minBuyers,
    momentumMinNetBuySol: Number(cfg.momentum.minNetBuyLamports) / 1e9,
    momentumMaxSellRatio: cfg.momentum.maxSellRatio,
    momentumMinAgeMs: cfg.momentum.minAgeMs,
    momentumMaxAgeMs: cfg.momentum.maxAgeMs,
    momentumMaxEarlyBuySol: Number(cfg.momentum.maxEarlyBuyLamports) / 1e9,
    momentumMaxTopBuyerPct: cfg.momentum.maxTopBuyerPct,
    takeProfit: cfg.exits.takeProfit.map((t) => ({ ...t })),
    stopLossPct: cfg.exits.stopLossPct,
    trailingStopPct: cfg.exits.trailingStopPct,
    trailingArmPct: cfg.exits.trailingArmPct,
    maxHoldSec: cfg.exits.maxHoldMs / 1000,
    staleSec: cfg.exits.staleMs / 1000,
    exitOnDevSell: cfg.exits.exitOnDevSell,
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
    entryMode: p.entryMode,
    momentum: {
      ...cfg.momentum,
      minBuyers: p.momentumMinBuyers,
      minNetBuyLamports: solToLamports(p.momentumMinNetBuySol),
      maxSellRatio: p.momentumMaxSellRatio,
      minAgeMs: Math.round(p.momentumMinAgeMs),
      maxAgeMs: Math.round(p.momentumMaxAgeMs),
      maxEarlyBuyLamports: solToLamports(p.momentumMaxEarlyBuySol),
      maxTopBuyerPct: p.momentumMaxTopBuyerPct,
    },
    exits: {
      ...cfg.exits,
      takeProfit: p.takeProfit.map((t) => ({ ...t })),
      stopLossPct: p.stopLossPct,
      trailingStopPct: p.trailingStopPct,
      trailingArmPct: p.trailingArmPct,
      maxHoldMs: Math.round(p.maxHoldSec * 1000),
      staleMs: Math.round(p.staleSec * 1000),
      exitOnDevSell: p.exitOnDevSell,
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
 * Applies `p` to the running bot in place. Entry, filters and exits are read
 * from `cfg` on every decision, so this takes effect on the next launch/trade.
 */
export function applyParams(cfg: Config, p: TunableParams): void {
  const next = withParams(cfg, p)
  cfg.entryMode = next.entryMode
  Object.assign(cfg.momentum, next.momentum)
  Object.assign(cfg.exits, next.exits)
  Object.assign(cfg.filters, next.filters)
}

export const tpToString = (tp: TunableParams['takeProfit']) =>
  tp.length ? tp.map((t) => `${round(t.gainPct, 1)}:${round(t.sellPct, 1)}`).join(',') : '0'

export function toEnv(p: TunableParams): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of Object.keys(ENV_NAMES) as (keyof TunableParams)[]) {
    const v = p[key]
    out[ENV_NAMES[key]] = key === 'takeProfit' ? tpToString(p.takeProfit) : typeof v === 'number' ? String(round(v)) : String(v)
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
    if (OPTIONAL.has(key) && (v === 0 || o === 0)) {
      // Off, or switched on/off: only the bounds of the "on" value apply.
      if (v !== 0 && v !== o && (v < lo || v > hi)) return false
      continue
    }
    // An out-of-bounds .env value may stay where the user put it, but the tuner never moves outside.
    if ((v < lo || v > hi) && v !== o) return false
    const step = STEP_LIMITS[key]
    if (step.abs !== undefined && Math.abs(v - o) > step.abs + 1e-9) return false
    if (step.factor !== undefined && o > 0 && (v > o * step.factor + 1e-9 || v < o / step.factor - 1e-9)) return false
  }
  // The config refuses a momentum window that closes before it opens.
  if (p.momentumMaxAgeMs <= p.momentumMinAgeMs) return false
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
 * True when `p` is inside the absolute bounds, ignoring step limits: what an
 * exploration (while the bot is not trading) may reach.
 */
export function withinBounds(p: TunableParams): boolean {
  for (const key of Object.keys(BOUNDS) as ScalarKey[]) {
    const [lo, hi] = BOUNDS[key]
    const v = p[key]
    if (OPTIONAL.has(key) && v === 0) continue
    if (v < lo || v > hi) return false
  }
  if (p.momentumMaxAgeMs <= p.momentumMinAgeMs) return false
  if (p.takeProfit.length > 3) return false
  for (const t of p.takeProfit) {
    if (t.gainPct < TP_GAIN_BOUNDS[0] || t.gainPct > TP_GAIN_BOUNDS[1]) return false
    if (t.sellPct < TP_SELL_BOUNDS[0] || t.sellPct > TP_SELL_BOUNDS[1]) return false
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

  set('entry mode', { entryMode: p.entryMode === 'instant' ? 'momentum' : 'instant' })
  // Momentum thresholds only matter when entering on momentum.
  if (p.entryMode === 'momentum') {
    for (const d of [-2, -1, 1, 2]) set('momentum buyers', { momentumMinBuyers: p.momentumMinBuyers + d })
    for (const v of scale(p.momentumMinNetBuySol, [0.5, 0.75, 1.5, 2])) set('momentum net buy', { momentumMinNetBuySol: v })
    for (const d of [-0.2, -0.1, 0.1, 0.2]) set('momentum sell ratio', { momentumMaxSellRatio: round(p.momentumMaxSellRatio + d, 2) })
    const optional = (v: number, on: number[]) => (v === 0 ? on : [0, ...scale(v, [0.5, 0.75, 1.5, 2], 2)])
    for (const v of optional(p.momentumMaxEarlyBuySol, [0.5, 1, 2, 5])) set('insider buys', { momentumMaxEarlyBuySol: v })
    for (const v of optional(p.momentumMaxTopBuyerPct, [2, 3, 5, 8])) set('top holder', { momentumMaxTopBuyerPct: v })
    for (const mn of [p.momentumMinAgeMs, Math.round(p.momentumMinAgeMs / 2), p.momentumMinAgeMs * 2]) {
      for (const mx of [p.momentumMaxAgeMs, Math.round(p.momentumMaxAgeMs / 2), p.momentumMaxAgeMs * 2]) {
        if (mn !== p.momentumMinAgeMs || mx !== p.momentumMaxAgeMs) set('momentum window', { momentumMinAgeMs: mn, momentumMaxAgeMs: mx })
      }
    }
  }

  for (const d of [-10, -5, 5, 10]) set('stop loss', { stopLossPct: p.stopLossPct + d })
  const trails = p.trailingStopPct === 0 ? [10, 15, 20] : [0, p.trailingStopPct - 5, p.trailingStopPct + 5, p.trailingStopPct + 10]
  for (const t of trails.filter((x) => x >= 0)) {
    for (const a of [p.trailingArmPct, p.trailingArmPct - 20, p.trailingArmPct + 20].filter((x) => x > 0)) {
      set('trailing stop', { trailingStopPct: t, trailingArmPct: a })
    }
  }
  for (const v of scale(p.maxHoldSec, [0.5, 0.75, 1.5, 2], 0)) set('max hold', { maxHoldSec: v })
  for (const v of scale(p.staleSec, [0.5, 0.75, 1.5, 2], 0)) set('stale exit', { staleSec: v })
  set('dev sell exit', { exitOnDevSell: !p.exitOnDevSell })
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

/** Short id of a set of settings, stored with each recorded launch. */
export const settingsFingerprint = (p: TunableParams) => createHash('sha1').update(paramsKey(p)).digest('hex').slice(0, 12)

/**
 * What a replay depends on: entry and exits, plus the entry mcap cap, which
 * the momentum rule also checks at the moment of entry.
 */
export const replayKey = (p: TunableParams) =>
  JSON.stringify([
    p.entryMode,
    p.entryMode === 'momentum'
      ? [
          p.momentumMinBuyers,
          p.momentumMinNetBuySol,
          p.momentumMaxSellRatio,
          p.momentumMinAgeMs,
          p.momentumMaxAgeMs,
          p.momentumMaxEarlyBuySol,
          p.momentumMaxTopBuyerPct,
          p.maxEntryMcapSol,
        ]
      : null,
    p.takeProfit,
    p.stopLossPct,
    p.trailingStopPct,
    p.trailingArmPct,
    p.maxHoldSec,
    p.staleSec,
    p.exitOnDevSell,
  ])

/** What the static filters depend on. */
export const filterKey = (p: TunableParams) =>
  JSON.stringify([p.devBuyMinSol, p.devBuyMaxSol, p.devMaxSupplyPct, p.maxEntryMcapSol, p.creatorMaxLaunches])
