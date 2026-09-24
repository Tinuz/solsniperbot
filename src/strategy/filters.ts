import type { Config } from '../config.js'
import { lamportsToSol } from '../config.js'
import { curveProgressBps, marketCapLamports } from '../pump/curve.js'
import type { Launch } from '../feed/market.js'

export type Verdict = { pass: true } | { pass: false; reason: string }

const PASS: Verdict = { pass: true }
const fail = (reason: string): Verdict => ({ pass: false, reason })

export interface FilterContext {
  initialRealTokenReserves: bigint
  /** Launches by the same dev wallet inside the reputation window, this one included. */
  creatorLaunches: number
}

/**
 * Synchronous launch filters. Everything here uses data already decoded from
 * the create transaction, so rejecting (or passing) a launch costs
 * microseconds, not round-trips. Cheapest checks run first.
 */
export function staticFilter(l: Launch, f: Config['filters'], ctx: FilterContext): Verdict {
  if (!l.isSolPaired) return fail('not SOL-paired')
  if (l.curve.complete) return fail('curve already complete')
  if (l.isMayhemMode && !f.allowMayhem) return fail('mayhem mode')
  if (l.isHolderReward && !f.allowHolderReward) return fail('holder-reward coin')
  if (f.requireUri && !l.uri) return fail('no metadata uri')

  const dev = l.dev.toBase58()
  const creator = l.creator.toBase58()
  if (f.creatorBlocklist.has(dev) || f.creatorBlocklist.has(creator)) return fail('creator blocklisted')
  const allowlisted = f.creatorAllowlist.has(dev) || f.creatorAllowlist.has(creator)
  if (f.creatorAllowlistOnly && !allowlisted) return fail('creator not allowlisted')

  const label = `${l.name} ${l.symbol}`
  if (f.nameBlocklist?.test(label)) return fail('name blocklisted')
  if (f.nameAllowlist && !f.nameAllowlist.test(label)) return fail('name not allowlisted')

  if (l.devBuyLamports < f.devBuyMinLamports) {
    return fail(`dev buy ${lamportsToSol(l.devBuyLamports).toFixed(3)} SOL below min`)
  }
  if (f.devBuyMaxLamports > 0n && l.devBuyLamports > f.devBuyMaxLamports) {
    return fail(`dev buy ${lamportsToSol(l.devBuyLamports).toFixed(3)} SOL above max`)
  }
  if (l.curve.tokenTotalSupply > 0n) {
    const devPct = Number((l.devBuyTokens * 10_000n) / l.curve.tokenTotalSupply) / 100
    if (devPct > f.devMaxSupplyPct) return fail(`dev holds ${devPct.toFixed(1)}% of supply`)
  }

  const progressPct = curveProgressBps(l.curve, ctx.initialRealTokenReserves) / 100
  if (progressPct > f.maxCurveProgressPct) return fail(`curve ${progressPct.toFixed(1)}% sold`)
  if (f.maxEntryMcapLamports > 0n && marketCapLamports(l.curve) > f.maxEntryMcapLamports) {
    return fail(`mcap ${lamportsToSol(marketCapLamports(l.curve)).toFixed(1)} SOL above max`)
  }

  if (!allowlisted && ctx.creatorLaunches > f.creatorMaxLaunches) {
    return fail(`serial launcher (${ctx.creatorLaunches} launches)`)
  }
  return PASS
}
