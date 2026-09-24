import { join } from 'node:path'
import type { Config } from '../config.js'
import { type Position, positionPnl } from '../trading/positions.js'
import type { Logger } from '../util/logger.js'
import { readJson, writeJsonAtomic } from '../util/persist.js'

const DAY_MS = 86_400_000
const DAYS_PER_MONTH = 30.4375
const PRICE_REFRESH_MS = 3_600_000
const PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd,eur'

export type SolPrice = { usd: number; eur: number; at: number }

interface CostsFile {
  v: 1
  since: number
  accruedLamports: number
  earnedLamports: number
  price?: SolPrice
}

/** Public SOL price (CoinGecko, no key needed). */
export async function fetchSolPrice(): Promise<SolPrice> {
  const res = await fetch(PRICE_URL, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`price API: HTTP ${res.status}`)
  const data = (await res.json()) as { solana?: { usd?: number; eur?: number } }
  const usd = data.solana?.usd
  const eur = data.solana?.eur
  if (!(usd && usd > 0 && eur && eur > 0)) throw new Error('price API: no SOL price in response')
  return { usd, eur, at: Date.now() }
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
