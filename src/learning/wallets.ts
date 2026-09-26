import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { LaunchRecord } from './record.js'

/**
 * Smart money: wallets whose early buys keep turning into runners.
 *
 * For every finished recording the recorder logs the early buyers (their
 * first buy within SMART_EARLY_MS of the launch, the dev and the bot itself
 * aside) and whether the price later reached SMART_HIT_MULTIPLE times what
 * they paid. A wallet with enough such buys and a hit rate well above the
 * average is "smart". Buying when smart wallets buy is how copy traders try
 * to get in before a run.
 *
 * Only finished launches count, so a wallet's score never uses anything that
 * happened after the moment it is used: live, and in every replay.
 */

/**
 * A wallet's first buy this soon after the launch counts as an early buy.
 * As long as the longest momentum window, so live and replayed decisions
 * see the same smart buyers.
 */
export const SMART_EARLY_MS = 60_000
/** The early buy was a hit when the price later reached this multiple of what the wallet paid. */
export const SMART_HIT_MULTIPLE = 2
/** Early buys a wallet needs before it can count as smart. */
export const SMART_MIN_APPEARANCES = 3
/** Smart: a (shrunk) hit rate of at least this... */
export const SMART_MIN_SCORE = 0.25
/** ...and at least this many times the average wallet's. */
export const SMART_LIFT = 2

/** `[wallet index in the record, address, hit (1) or not (0)]` */
export type EarlyBuy = [number, string, 0 | 1]

/** One finished launch's early buyers, as logged to `data/wallets/<day>.jsonl`. */
export interface WalletEntry {
  mint: string
  /** Launch detected (ms). */
  t: number
  /** When the outcome was known: the end of the recording (ms). */
  until: number
  buys: EarlyBuy[]
}

/**
 * The early buyers of a finished recording and whether each saw the price
 * reach SMART_HIT_MULTIPLE after their buy. `addresses[i]` is the wallet
 * with index i in the trade rows (0 = the dev).
 */
export function earlyBuys(rec: Pick<LaunchRecord, 'trades'>, addresses: readonly string[], ignore: ReadonlySet<string> = new Set()): EarlyBuy[] {
  const rows = rec.trades
  // Highest price after each row.
  const peakAfter = new Array<number>(rows.length)
  let peak = 0
  for (let i = rows.length - 1; i >= 0; i--) {
    peakAfter[i] = peak
    const [, vq, vt] = rows[i]!
    if (vt > 0) peak = Math.max(peak, vq / vt)
  }
  const out: EarlyBuy[] = []
  const seen = new Set<number>()
  for (let i = 0; i < rows.length; i++) {
    const [dt, vq, vt, side, , wallet] = rows[i]!
    if (dt > SMART_EARLY_MS) break
    if (side <= 0 || wallet === 0 || seen.has(wallet)) continue
    seen.add(wallet)
    const address = addresses[wallet]
    if (!address || ignore.has(address) || vt <= 0) continue
    out.push([wallet, address, peakAfter[i]! >= SMART_HIT_MULTIPLE * (vq / vt) ? 1 : 0])
  }
  return out
}

/**
 * Smart money is judged on the early buys whose outcome became known in
 * this many days before the moment of the decision: live and in every
 * replay alike, so the signal validated offline is the one traded.
 */
export const SMART_WINDOW_DAYS = 14
const DAY_MS = 86_400_000

interface WalletStat {
  address: string
  n: number
  hits: number
}

/** The early buys whose outcome was known on one UTC day, to forget them together. */
interface DayBucket {
  day: number
  hit: WalletStat[]
  miss: WalletStat[]
}

/**
 * Early-buy history per wallet over a rolling window, and who counts as
 * smart money. Memory stays bounded however long the bot runs: early buys
 * older than the window are forgotten, and a wallet with none left is
 * dropped.
 */
export class WalletBook {
  private readonly wallets = new Map<string, WalletStat>()
  /** Oldest day first. */
  private readonly buckets: DayBucket[] = []
  private totalBuys = 0
  private totalHits = 0
  /** Latest `until` added: nothing after it is known. */
  knownUntil = 0

  constructor(private readonly windowDays = SMART_WINDOW_DAYS) {}

  /** Adds a finished launch's early buys, and forgets what fell out of the window by its time. */
  add(e: WalletEntry): void {
    const bucket = this.bucket(Math.floor(e.until / DAY_MS))
    for (const [, address, hit] of e.buys) {
      let w = this.wallets.get(address)
      if (!w) {
        w = { address, n: 0, hits: 0 }
        this.wallets.set(address, w)
      }
      w.n++
      w.hits += hit
      ;(hit ? bucket.hit : bucket.miss).push(w)
      this.totalBuys++
      this.totalHits += hit
    }
    if (e.until > this.knownUntil) this.knownUntil = e.until
    this.prune(this.knownUntil)
  }

  /** Forgets the early buys whose outcome is older than the window before `now`. */
  prune(now: number): void {
    const oldest = Math.floor((now - this.windowDays * DAY_MS) / DAY_MS)
    while (this.buckets.length && this.buckets[0]!.day < oldest) {
      const b = this.buckets.shift()!
      for (const w of b.hit) this.forget(w, 1)
      for (const w of b.miss) this.forget(w, 0)
    }
  }

  /** Share of all early buys that were hits. */
  get baseRate(): number {
    return this.totalBuys ? this.totalHits / this.totalBuys : 0
  }

  get size(): number {
    return this.wallets.size
  }

  /** Hit rate shrunk towards zero, so a lucky 3 out of 3 doesn't look like a sure thing. */
  score(address: string): number {
    const w = this.wallets.get(address)
    return w ? w.hits / (w.n + 2) : 0
  }

  get threshold(): number {
    return Math.max(SMART_MIN_SCORE, SMART_LIFT * this.baseRate)
  }

  isSmart(address: string): boolean {
    const w = this.wallets.get(address)
    return !!w && w.n >= SMART_MIN_APPEARANCES && w.hits / (w.n + 2) >= this.threshold
  }

  /** How many wallets count as smart right now (walks the whole book: for reports, not the hot path). */
  smartCount(): number {
    const min = this.threshold
    let n = 0
    for (const w of this.wallets.values()) if (w.n >= SMART_MIN_APPEARANCES && w.hits / (w.n + 2) >= min) n++
    return n
  }

  private bucket(day: number): DayBucket {
    const last = this.buckets[this.buckets.length - 1]
    if (last?.day === day) return last
    // Outcomes arrive nearly in order: search from the newest day.
    let i = this.buckets.length
    while (i > 0 && this.buckets[i - 1]!.day > day) i--
    if (i > 0 && this.buckets[i - 1]!.day === day) return this.buckets[i - 1]!
    const b: DayBucket = { day, hit: [], miss: [] }
    this.buckets.splice(i, 0, b)
    return b
  }

  private forget(w: WalletStat, hit: 0 | 1): void {
    w.n--
    w.hits -= hit
    this.totalBuys--
    this.totalHits -= hit
    if (w.n <= 0) this.wallets.delete(w.address)
  }
}

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/

/** Logged early buys since `fromDay` (`YYYY-MM-DD`, inclusive), oldest outcome first. */
export async function readWalletEntries(dataDir: string, fromDay = '0000-00-00'): Promise<WalletEntry[]> {
  const dir = join(dataDir, 'wallets')
  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => DAY_FILE.test(f) && f.slice(0, 10) >= fromDay).sort()
  } catch {
    return []
  }
  const out: WalletEntry[] = []
  for (const f of files) {
    const lines = createInterface({ input: createReadStream(join(dir, f)), crlfDelay: Number.POSITIVE_INFINITY })
    for await (const line of lines) {
      if (!line) continue
      try {
        const e = JSON.parse(line) as WalletEntry
        if (Array.isArray(e.buys)) out.push(e)
      } catch {
        // A torn last line from a crash; skip it.
      }
    }
  }
  return out.sort((a, b) => a.until - b.until)
}

/**
 * Sets `rec.smart` on every record: the wallet indices of its early buyers
 * that were smart money at the moment of the launch, judged only on launches
 * whose outcome was known by then, over the same rolling window as the live
 * book. Records without logged buyers get none.
 */
export function annotateSmartBuyers(records: LaunchRecord[], entries: WalletEntry[]): void {
  const byMint = new Map(entries.map((e) => [e.mint, e]))
  const sorted = [...records].sort((a, b) => a.t - b.t)
  const book = new WalletBook()
  let next = 0
  for (const rec of sorted) {
    while (next < entries.length && entries[next]!.until <= rec.t) book.add(entries[next++]!)
    book.prune(rec.t)
    const own = byMint.get(rec.mint)
    rec.smart = own ? own.buys.filter(([, address]) => book.isSmart(address)).map(([index]) => index) : []
  }
}

/** Loads the logged early buys around `records` and annotates them (see `annotateSmartBuyers`). */
export async function annotateFromDisk(dataDir: string, records: LaunchRecord[]): Promise<void> {
  if (!records.length) return
  const first = records.reduce((m, r) => Math.min(m, r.t), Number.POSITIVE_INFINITY)
  const fromDay = new Date(first - SMART_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10)
  annotateSmartBuyers(records, await readWalletEntries(dataDir, fromDay))
}
