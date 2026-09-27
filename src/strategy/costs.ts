import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { Config } from '../config.js'
import { type Position, positionPnl } from '../trading/positions.js'
import type { Logger } from '../util/logger.js'
import { readJson, writeJsonAtomic } from '../util/persist.js'

const DAY_MS = 86_400_000
const DAYS_PER_MONTH = 30.4375
const PRICE_REFRESH_MS = 3_600_000

/** Public SOL price sources (no key needed), tried in order. */
export const PRICE_SOURCES: PriceSource[] = [
  {
    name: 'CoinGecko',
    url: 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd,eur',
    parse: (d) => {
      const s = (d as { solana?: { usd?: number; eur?: number } }).solana
      return { usd: s?.usd, eur: s?.eur }
    },
  },
  {
    name: 'Binance',
    url: 'https://api.binance.com/api/v3/ticker/price?symbols=%5B%22SOLUSDT%22,%22SOLEUR%22%5D',
    parse: (d) => {
      const rows = Array.isArray(d) ? (d as { symbol?: string; price?: string }[]) : []
      const at = (symbol: string) => Number(rows.find((r) => r.symbol === symbol)?.price)
      return { usd: at('SOLUSDT'), eur: at('SOLEUR') }
    },
  },
]

export interface PriceSource {
  name: string
  url: string
  parse(data: unknown): { usd?: number; eur?: number }
}

export type SolPrice = { usd: number; eur: number; at: number }

interface CostsFile {
  v: 1
  since: number
  accruedLamports: number
  earnedLamports: number
  price?: SolPrice
}

/**
 * JSON from a response body. Some CDNs send a gzipped body without saying so
 * (no Content-Encoding), which fetch then hands over still compressed.
 */
export function parseJsonBody(body: Buffer): unknown {
  const raw = body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body
  return JSON.parse(raw.toString('utf8'))
}

/** Public SOL price in USD and EUR: the first source that answers with both. */
export async function fetchSolPrice(sources: PriceSource[] = PRICE_SOURCES): Promise<SolPrice> {
  const errors: string[] = []
  for (const src of sources) {
    try {
      const res = await fetch(src.url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json', 'accept-encoding': 'identity' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { usd, eur } = src.parse(parseJsonBody(Buffer.from(await res.arrayBuffer())))
      if (!(usd && usd > 0 && eur && eur > 0)) throw new Error('no SOL price in the response')
      return { usd, eur, at: Date.now() }
    } catch (err) {
      errors.push(`${src.name}: ${(err as Error).message}`)
    }
  }
  throw new Error(`price API: ${errors.join('; ')}`)
}

/**
 * What the bot costs to exist (RPC plan, server) against what it earns.
 * Costs accrue while it runs, converted to SOL at the current price; earnings
 * are the P&L of every trade closed since the ledger started. A bot that
 * does not cover its costs is not keeping itself alive, whatever its win rate.
 */
export class OperatingCosts {
  private state: CostsFile
  private readonly path: string
  private lastAccrual: number
  private priceTimer?: NodeJS.Timeout

  constructor(
    private readonly cfg: Config,
    private readonly log: Logger,
    private readonly opts: { fetchPrice?: () => Promise<SolPrice>; now?: () => number } = {},
  ) {
    this.path = join(cfg.dataDir, `costs-${cfg.dryRun ? 'paper' : 'live'}.json`)
    const now = this.now()
    this.state = { v: 1, since: now, accruedLamports: 0, earnedLamports: 0 }
    this.lastAccrual = now
  }

  get enabled(): boolean {
    return this.cfg.costs.perMonth > 0
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  async load(): Promise<void> {
    const saved = await readJson<CostsFile>(this.path)
    if (saved?.v === 1) this.state = saved
    // Only running time is charged: the ledger compares costs with what the bot could earn meanwhile.
    this.lastAccrual = this.now()
    // Not awaited: a slow price API must not delay the start. Until it answers
    // the costs are unpriced and the edge gate treats them as not covered.
    if (this.enabled && this.cfg.costs.currency !== 'sol') void this.refreshPrice()
  }

  start(): void {
    if (!this.enabled || this.cfg.costs.currency === 'sol') return
    this.priceTimer = setInterval(() => void this.refreshPrice(), PRICE_REFRESH_MS)
    this.priceTimer.unref()
  }

  async stop(): Promise<void> {
    clearInterval(this.priceTimer)
    this.accrue()
    await this.persist()
  }

  /** Operating cost per day in lamports; null while the SOL price is unknown. */
  perDayLamports(): number | null {
    const { perMonth, currency } = this.cfg.costs
    if (perMonth <= 0) return 0
    const perDay = perMonth / DAYS_PER_MONTH
    if (currency === 'sol') return Math.round(perDay * 1e9)
    const price = this.state.price?.[currency]
    return price ? Math.round((perDay / price) * 1e9) : null
  }

  /** Books elapsed running time. Call regularly (the engine does every minute). */
  accrue(): void {
    const now = this.now()
    const perDay = this.perDayLamports()
    if (perDay) this.state.accruedLamports += (perDay * (now - this.lastAccrual)) / DAY_MS
    this.lastAccrual = now
  }

  bookClosed(pos: Position): void {
    this.state.earnedLamports += Number(positionPnl(pos))
  }

  /** A closed position's P&L turned out different on-chain (see PositionManager.reconcile). */
  bookCorrection(lamports: bigint): void {
    this.state.earnedLamports += Number(lamports)
  }

  async persist(): Promise<void> {
    try {
      await writeJsonAtomic(this.path, this.state)
    } catch (err) {
      this.log.warn({ err }, 'costs ledger write failed')
    }
  }

  status() {
    const { perMonth, currency } = this.cfg.costs
    const perDay = this.perDayLamports()
    return {
      perMonth,
      currency,
      solPrice: this.state.price ? { usd: this.state.price.usd, eur: this.state.price.eur, at: this.state.price.at } : null,
      perDaySol: perDay === null ? null : perDay / 1e9,
      accruedSol: this.state.accruedLamports / 1e9,
      earnedSol: this.state.earnedLamports / 1e9,
      netLamports: Math.round(this.state.earnedLamports - this.state.accruedLamports),
      sinceDays: (this.now() - this.state.since) / DAY_MS,
    }
  }

  private async refreshPrice(): Promise<void> {
    try {
      this.accrue() // book the time so far at the old price
      this.state.price = await (this.opts.fetchPrice ?? fetchSolPrice)()
    } catch (err) {
      const age = this.state.price ? Math.round((this.now() - this.state.price.at) / 3_600_000) : undefined
      this.log.warn({ err: (err as Error).message, lastPriceAgeHours: age }, 'SOL price refresh failed; using the last known price')
    }
  }
}
