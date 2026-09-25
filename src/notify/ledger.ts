import { createReadStream, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { type Position, positionPnl } from '../trading/positions.js'

/** One finished trade, as the Telegram reports count it. */
export interface LedgerEntry {
  at: number
  mint: string
  symbol: string
  /** Net P&L in lamports, every fee included. */
  pnl: number
  /** Stake in lamports (0 for a failed buy). */
  cost: number
  /** The buy failed: only its network fee was lost. */
  failed?: boolean
  moonbag?: boolean
}

export interface LedgerStats {
  /** Finished trades; failed buys are counted separately. */
  trades: number
  wins: number
  failed: number
  /** Everything, failed buys' fees included. */
  pnl: number
  /** P&L without the single best trade: does it hold up without one lucky coin? */
  withoutBest: number
  best?: LedgerEntry
  worst?: LedgerEntry
  moonbags: number
}

/** Kept long enough for a week's numbers. */
const KEEP_MS = 8 * 86_400_000

/**
 * The trades the reports are about, kept for a week and saved with the
 * notifier's state, so "today" and the digests survive restarts (the
 * position manager only keeps the last few hundred in memory).
 */
export class TradeLedger {
  private entries: LedgerEntry[]

  constructor(entries: LedgerEntry[] = []) {
    this.entries = [...entries].sort((a, b) => a.at - b.at)
  }

  add(p: Position, at = p.closedAt ?? Date.now()): LedgerEntry {
    const failed = p.status === 'failed'
    const e: LedgerEntry = {
      at,
      mint: p.mint,
      symbol: p.symbol,
      pnl: Number(failed ? -p.networkFeesLamports : positionPnl(p)),
      cost: failed ? 0 : Number(p.costLamports),
      ...(failed ? { failed: true } : {}),
      ...(p.moonbag ? { moonbag: true } : {}),
    }
    this.entries.push(e)
    this.prune(at)
    return e
  }

  since(from: number, until = Number.POSITIVE_INFINITY): LedgerEntry[] {
    return this.entries.filter((e) => e.at >= from && e.at < until)
  }

  get first(): LedgerEntry | undefined {
    return this.entries[0]
  }

  get size(): number {
    return this.entries.length
  }

  prune(now = Date.now()): void {
    const cut = now - KEEP_MS
    if (this.entries.length && this.entries[0]!.at < cut) this.entries = this.entries.filter((e) => e.at >= cut)
  }

  toJSON(): LedgerEntry[] {
    return this.entries
  }

  static stats(es: LedgerEntry[]): LedgerStats {
    const done = es.filter((e) => !e.failed)
    let best: LedgerEntry | undefined
    let worst: LedgerEntry | undefined
    for (const e of done) {
      if (!best || e.pnl > best.pnl) best = e
      if (!worst || e.pnl < worst.pnl) worst = e
    }
    const pnl = es.reduce((a, e) => a + e.pnl, 0)
    return {
      trades: done.length,
      wins: done.filter((e) => e.pnl > 0).length,
      failed: es.length - done.length,
      pnl,
      withoutBest: pnl - Math.max(0, best?.pnl ?? 0),
      best,
      worst,
      moonbags: done.filter((e) => e.moonbag).length,
    }
  }
}

/**
 * Paper: the trades since the paper wallet was last reset are the newest ones
 * that add up to exactly its realized P&L (lamports, so a coincidence is
 * practically impossible). When the reset is older than `entries`, all of
 * them count.
 */
export function sincePaperReset(entries: LedgerEntry[], realized: number): LedgerEntry[] {
  let sum = 0
  let start = realized === 0 ? entries.length : -1
  for (let i = entries.length - 1; i >= 0; i--) {
    sum += entries[i]!.pnl
    if (sum === realized) start = i
  }
  return start < 0 ? entries : entries.slice(start)
}

/**
 * Finished trades from the bot's trade journal (`data/trades.jsonl`), to fill
 * the ledger the first time: the reports then cover what happened before.
 */
export async function readJournalTrades(path: string, since: number, paper: boolean): Promise<LedgerEntry[]> {
  if (!existsSync(path)) return []
  const out: LedgerEntry[] = []
  const lastByMint = new Map<string, LedgerEntry>()
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Number.POSITIVE_INFINITY })
  for await (const line of lines) {
    if (!line.includes('"type":"close"') && !line.includes('"type":"reconcile"')) continue
    let r: { type: string; at: number; mint: string; symbol?: string; paper?: boolean; pnlLamports?: string | number; cost?: string | number }
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    if (r.type === 'reconcile') {
      // Live: the exact on-chain P&L replaces the estimate.
      const e = lastByMint.get(r.mint)
      if (e && r.pnlLamports !== undefined) e.pnl = Number(r.pnlLamports)
      continue
    }
    if (r.at < since || (r.paper ?? paper) !== paper) continue
    const e: LedgerEntry = { at: r.at, mint: r.mint, symbol: r.symbol ?? '?', pnl: Number(r.pnlLamports ?? 0), cost: Number(r.cost ?? 0) }
    out.push(e)
    lastByMint.set(r.mint, e)
  }
  return out
}
