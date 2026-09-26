import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { PublicKey } from '@solana/web3.js'
import type { Launch } from '../feed/market.js'
import type { LaunchRecord } from './record.js'
import { annotateFromDisk } from './wallets.js'

/**
 * Loads recorded launches, oldest first. `days` keeps only the most recent N
 * daily files. Beyond `max` launches an even sample across the whole period
 * is kept (not just the newest), and only sampled lines are parsed.
 */
export async function loadRecords(dataDir: string, opts: { days?: number; max?: number } = {}): Promise<LaunchRecord[]> {
  return (await loadSample(dataDir, opts)).records
}

/** Like `loadRecords`, plus how many recorded launches each loaded one stands for. */
export async function loadSample(dataDir: string, opts: { days?: number; max?: number } = {}): Promise<{ records: LaunchRecord[]; stride: number }> {
  const dir = join(dataDir, 'launches')
  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()
  } catch {
    return { records: [], stride: 1 }
  }
  if (opts.days) files = files.slice(-opts.days)
  let stride = 1
  if (opts.max) {
    let total = 0
    for (const f of files) total += await countLines(join(dir, f))
    if (total > opts.max) stride = total / opts.max
  }
  const out: LaunchRecord[] = []
  let index = 0
  let next = 0
  for (const f of files) {
    const lines = createInterface({ input: createReadStream(join(dir, f)), crlfDelay: Number.POSITIVE_INFINITY })
    for await (const line of lines) {
      if (!line) continue
      if (index++ < next) continue
      next += stride
      try {
        const rec = JSON.parse(line) as LaunchRecord
        if (rec.v === 1 && Array.isArray(rec.trades)) out.push(rec)
      } catch {
        // A torn last line from a crash; skip it.
      }
    }
  }
  out.sort((a, b) => a.t - b.t)
  // Which early buyers were smart money at each launch, from the logged early buys (no look-ahead).
  await annotateFromDisk(dataDir, out)
  return { records: out, stride }
}

async function countLines(path: string): Promise<number> {
  let n = 0
  for await (const chunk of createReadStream(path)) {
    const buf = chunk as Buffer
    for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) n++
  }
  return n
}

/** Chronological split: the most recent `testFrac` of launches is held out. */
export function splitByTime<T extends { t: number }>(rows: T[], testFrac = 0.3): { train: T[]; test: T[] } {
  const cut = Math.floor(rows.length * (1 - testFrac))
  return { train: rows.slice(0, cut), test: rows.slice(cut) }
}

/** Rebuilds the `Launch` the live filters saw, so current filter settings can be applied offline. */
export function launchFromRecord(r: LaunchRecord): Launch {
  const mint = new PublicKey(r.mint)
  return {
    mint,
    mintStr: r.mint,
    name: r.name,
    symbol: r.symbol,
    uri: r.uri,
    creator: new PublicKey(r.creator),
    dev: new PublicKey(r.dev),
    tokenProgram: new PublicKey(r.tokenProgram),
    isMayhemMode: r.mayhem,
    isHolderReward: r.holderReward,
    quoteMint: PublicKey.default,
    isSolPaired: true,
    curve: {
      virtualTokenReserves: BigInt(r.curve.vt),
      virtualQuoteReserves: BigInt(r.curve.vq),
      realTokenReserves: BigInt(r.curve.rt),
      realQuoteReserves: 0n,
      tokenTotalSupply: BigInt(r.curve.supply),
      complete: false,
      creator: new PublicKey(r.creator),
      isMayhemMode: r.mayhem,
      creatorFeeBps: 0n,
    },
    devBuyLamports: BigInt(r.devBuyLamports),
    devBuyTokens: BigInt(r.devBuyTokens),
    signature: '',
    slot: r.slot,
    detectedAt: 0,
    detectedAtWall: r.t,
    source: r.source,
    executed: r.executed,
  }
}
