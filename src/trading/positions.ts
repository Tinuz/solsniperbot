import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { PublicKey } from '@solana/web3.js'
import type { Config } from '../config.js'
import { lamportsToSol } from '../config.js'
import type { MarketBook, MintState } from '../feed/market.js'
import { curveFromAccount, feeRates, quoteSell } from '../pump/curve.js'
import { decodeBondingCurve } from '../pump/layouts.js'
import { bondingCurvePda } from '../pump/pda.js'
import type { PumpProtocol } from '../pump/protocol.js'
import type { RpcClient } from '../solana/rpc.js'
import { type ExitDecision, type PositionBooks, decideExit } from '../strategy/exits.js'
import type { RiskManager } from '../strategy/risk.js'
import type { Logger } from '../util/logger.js'
import { DebouncedWriter, Journal, readJson } from '../util/persist.js'
import { sleep } from '../util/time.js'
import type { BuyRequest, Executor, SimulationReport, SubmitHooks, Timings, TradeResult } from './executor.js'
import { BASE_FEE_LAMPORTS, priorityLamports } from './fees.js'

export type PositionStatus = 'opening' | 'open' | 'closing' | 'closed' | 'failed'

/**
 * A transaction whose outcome the bot does not know (it stopped or crashed
 * while it was in flight), or a restart after which what the wallet holds
 * must be checked. The position is not traded until the chain settles it.
 */
export interface PendingTx {
  /** `sync`: no transaction known; compare the holdings with the wallet. */
  side: 'buy' | 'sell' | 'sync'
  signature?: string
  /** After this block height the transaction can no longer land. */
  lastValidBlockHeight?: number
  /** Sell: the tokens it sells, and how the sale is booked if it landed. */
  tokens?: bigint
  reason?: string
  tier?: number
  moonbag?: boolean
  since: number
}

export interface SellRecord {
  at: number
  tokens: bigint
  lamports: bigint
  signature: string
  reason: string
}

export interface Position {
  mint: string
  name: string
  symbol: string
  tokenProgram: string
  creator: string
  dev?: string
  isMayhemMode: boolean
  paper: boolean
  status: PositionStatus
  entryReason: string
  openedAt: number
  closedAt?: number
  launchSlot?: number
  entrySlot?: number
  /** Wall-clock time the buy filled. */
  filledAt?: number
  slotsAfterLaunch?: number
  buySignature?: string
  /** Lamports paid for the tokens, trade fees included. */
  costLamports: bigint
  tokensBought: bigint
  tokensHeld: bigint
  /** Lamports received from sells, after trade fees. */
  realizedLamports: bigint
  /** Tips, priority fees and base fees (estimated until reconciled on-chain). */
  networkFeesLamports: bigint
  /** Exact net SOL change of the wallet across this position's transactions (live only). */
  walletDeltaLamports?: bigint
  /** Landed transactions, and how many of them have been reconciled on-chain. */
  landedTxs: number
  reconciledTxs: number
  reconciled: boolean
  /** P&L already booked into the totals (adjusted when reconciliation lands later). */
  bookedPnlLamports?: bigint
  tiersDone: number
  /** Down to its moonbag: stake, fees and a profit are secured, the rest rides (see MOONBAG_PCT). */
  moonbag?: boolean
  moonbagAt?: number
  gainPct: number
  peakGainPct: number
  valueLamports: bigint
  lastPriceAt: number
  sells: SellRecord[]
  sellAttempts: number
  /** Backoff after a failed sell cycle so a stuck exit doesn't spin every tick. */
  nextSellAt: number
  closeReason?: string
  error?: string
  timings?: Timings
  simulation?: SimulationReport
  /** Outcome not known yet: see PendingTx. */
  pending?: PendingTx
  nextResolveAt?: number
  /** Failed sell rounds in a row (the owner hears about a stuck exit). */
  sellFailures?: number
  /** Failed on-chain checks in a row while pending (the owner hears about it). */
  resolveFailures?: number
  /** Landed transactions whose exact wallet change is not booked yet (retried after a restart). */
  unreconciled?: string[]
  /** Why this position's P&L stays an estimate even once reconciled (a sale the bot did not see). */
  estimated?: string
}

export interface PositionStats {
  closed: number
  wins: number
  losses: number
  netPnlLamports: bigint
  bestPnlLamports: bigint
  worstPnlLamports: bigint
  avgHoldMs: number
}

/** Failed sell rounds in a row before the owner is alerted. */
const STUCK_ALERT_ROUNDS = 3
/** Failed on-chain checks of a pending position (one every 10 s) before the owner is alerted. */
const UNSETTLED_ALERT_TRIES = 6
/** Without a known transaction, a restored buy that has not shown up by then never will. */
const UNKNOWN_TX_MS = 120_000

/** Net P&L: realized + current value - cost - network fees. */
export function positionPnl(p: Position): bigint {
  if (p.reconciled && p.walletDeltaLamports !== undefined && !p.estimated) return p.walletDeltaLamports + p.valueLamports
  return p.realizedLamports + p.valueLamports - p.costLamports - p.networkFeesLamports
}

interface Deps {
  cfg: Config
  /** How long to wait before checking a pending position on-chain again after an RPC error (default 10 s). */
  retryMs?: number
  executor: Executor
  market: MarketBook
  protocol: PumpProtocol
  risk: RiskManager
  rpc: RpcClient
  log: Logger
}

export interface OpenRequest extends BuyRequest {
  name: string
  symbol: string
  dev?: string
  reason: string
  launchSlot?: number
}

/**
 * Owns every position from buy to close: live repricing on each trade,
 * exit decisions, sells with escalating-slippage retries, persistence and
 * P&L booking.
 */
export class PositionManager extends EventEmitter<{
  update: [Position]
  closed: [Position]
  /** Booked P&L of a finished position was corrected by the exact on-chain amount. */
  reconciled: [Position, bigint]
  /** Something the owner must hear about (a stuck exit, tokens gone from the wallet). */
  alert: [string]
}> {
  private readonly active = new Map<string, Position>()
  private readonly recent: Position[] = []
  /** Mints with a buy, sell or on-chain check in flight: never two at once. */
  private readonly busy = new Set<string>()
  /** Buys, sells and checks in flight, so a shutdown can wait for them. */
  private readonly inflight = new Set<Promise<unknown>>()
  /** The other mode's positions (DRY_RUN switched): kept in the file untouched, not managed. */
  private foreign: unknown[] = []
  /** Finished live positions whose last transactions are not reconciled yet: saved, so a restart finishes them. */
  private readonly settling = new Map<string, Position>()
  private stopping = false
  private readonly journal: Journal
  private readonly store: DebouncedWriter
  private readonly totals: PositionStats = {
    closed: 0,
    wins: 0,
    losses: 0,
    netPnlLamports: 0n,
    bestPnlLamports: 0n,
    worstPnlLamports: 0n,
    avgHoldMs: 0,
  }
  private timer?: NodeJS.Timeout

  constructor(private readonly d: Deps) {
    super()
    const onError = (err: unknown) => d.log.error({ err }, 'failed to persist positions')
    this.journal = new Journal(join(d.cfg.dataDir, 'trades.jsonl'), onError)
    this.store = new DebouncedWriter(join(d.cfg.dataDir, 'positions.json'), () => [...this.active.values(), ...this.settling.values(), ...this.foreign], 200, onError)
  }

  // Lifecycle -----------------------------------------------------------------

  async start(): Promise<void> {
    await this.restore()
    this.timer = setInterval(() => this.tick(), 1_000)
  }

  /**
   * First step of a shutdown: no new buys or sell attempts, then waits up to
   * `timeoutMs` for the transactions in flight to finish normally.
   */
  async drain(timeoutMs: number): Promise<void> {
    this.stopping = true
    clearInterval(this.timer)
    const deadline = Date.now() + timeoutMs
    while (this.inflight.size > 0 && Date.now() < deadline) await sleep(50)
  }

  /**
   * Last step, after the signature tracker stopped: a transaction still in
   * flight was reported `aborted` and stays saved as pending, for the next
   * start to settle on-chain. Then the final save; nothing writes after it.
   */
  async stop(): Promise<void> {
    this.stopping = true
    clearInterval(this.timer)
    await Promise.allSettled([...this.inflight])
    await this.store.close()
    await this.journal.flush()
  }

  /** A shutdown has begun: no new positions. */
  get stopped(): boolean {
    return this.stopping
  }

  has(mint: string): boolean {
    return this.active.has(mint)
  }

  get(mint: string): Position | undefined {
    return this.active.get(mint)
  }

  /** Positions that count against MAX_OPEN_POSITIONS: moonbags don't, they have their own limit. */
  get openCount(): number {
    let n = 0
    for (const p of this.active.values()) if (!p.moonbag) n++
    return n
  }

  get moonbagCount(): number {
    return this.active.size - this.openCount
  }

  list(): Position[] {
    return [...this.active.values()]
  }

  history(): Position[] {
    return this.recent.slice()
  }

  stats(): PositionStats {
    return { ...this.totals }
  }

  // Entry ---------------------------------------------------------------------

  async open(req: OpenRequest): Promise<Position> {
    const mint = req.mint.toBase58()
    if (this.stopping) throw new Error('shutting down')
    // Checked and registered with no await in between: a second buy of the same coin cannot slip through.
    if (this.active.has(mint) || this.busy.has(mint)) throw new Error('already holding this coin')
    const pos: Position = {
      mint,
      name: req.name,
      symbol: req.symbol,
      tokenProgram: req.tokenProgram.toBase58(),
      creator: req.creator.toBase58(),
      dev: req.dev,
      isMayhemMode: req.isMayhemMode,
      paper: this.d.executor.paper,
      status: 'opening',
      entryReason: req.reason,
      openedAt: Date.now(),
      launchSlot: req.launchSlot,
      costLamports: req.lamports,
      tokensBought: 0n,
      tokensHeld: 0n,
      realizedLamports: 0n,
      networkFeesLamports: 0n,
      landedTxs: 0,
      reconciledTxs: 0,
      reconciled: false,
      tiersDone: 0,
      gainPct: 0,
      peakGainPct: 0,
      valueLamports: 0n,
      lastPriceAt: 0,
      sells: [],
      sellAttempts: 0,
      nextSellAt: 0,
    }
    this.active.set(mint, pos)
    this.busy.add(mint)
    this.d.risk.recordBuy()
    this.changed(pos)
    try {
      return await this.track(this.runBuy(pos, req))
    } finally {
      this.busy.delete(mint)
    }
  }

  private async runBuy(pos: Position, req: OpenRequest): Promise<Position> {
    const result = await this.d.executor.buy(req, this.saveSubmitted(pos, 'buy'))
    if (!result.ok && result.aborted) {
      this.d.log.warn({ mint: pos.mint, signature: result.signature }, 'stopped with a buy in flight: the next start checks whether it landed')
      this.changed(pos)
      return pos
    }
    pos.pending = undefined
    if (!result.ok) {
      pos.status = 'failed'
      pos.error = result.error
      pos.buySignature = result.signature
      pos.timings = result.timings
      pos.closedAt = Date.now()
      pos.costLamports = 0n
      // A buy that executed and failed still paid its network fee (tips only move on success).
      if (result.landed) {
        pos.networkFeesLamports = result.networkFeeLamports ?? BASE_FEE_LAMPORTS + priorityLamports(this.d.cfg, 'buy')
        if (!pos.paper && result.signature) this.landedFailure(pos, result.signature)
      }
      this.finish(pos)
      void this.journal.append({ type: 'buy-failed', at: Date.now(), mint: pos.mint, error: result.error, signature: result.signature, paper: pos.paper })
      return pos
    }
    this.applyBuy(pos, result)
    return pos
  }

  /** Saves the signature of a transaction on its way, so a restart can settle it on-chain. */
  private saveSubmitted(pos: Position, side: 'buy'): SubmitHooks
  private saveSubmitted(pos: Position, side: 'sell', sale: Pick<PendingTx, 'tokens' | 'reason' | 'tier' | 'moonbag'>): SubmitHooks
  private saveSubmitted(pos: Position, side: 'buy' | 'sell', sale: Partial<PendingTx> = {}): SubmitHooks {
    return {
      onSubmit: (signature, lastValidBlockHeight) => {
        if (side === 'buy') pos.buySignature = signature
        pos.pending = { side, signature, lastValidBlockHeight, ...sale, since: Date.now() }
        // Written now, not debounced: a hard kill right after sending must not lose the signature.
        void this.store.flush()
      },
    }
  }

  private applyBuy(pos: Position, r: Extract<TradeResult, { ok: true }>): void {
    pos.status = 'open'
    if (r.signature) pos.buySignature = r.signature
    pos.filledAt = Date.now()
    pos.entrySlot = r.slot || undefined
    pos.slotsAfterLaunch = pos.launchSlot && r.slot ? r.slot - pos.launchSlot : undefined
    pos.tokensBought = r.tokens
    pos.tokensHeld = r.tokens
    if (r.lamports > 0n) pos.costLamports = r.lamports
    pos.networkFeesLamports += r.networkFeeLamports
    pos.timings = r.timings
    pos.simulation = r.simulation
    pos.lastPriceAt = Date.now()
    if (!pos.paper && r.signature) this.markLanded(pos, r.signature)
    if (pos.tokensHeld === 0n) {
      pos.status = 'failed'
      pos.error = 'buy landed but token balance could not be determined; check the wallet manually'
      this.alert(`⚠️ ${pos.symbol}: buy landed but no tokens were found in the wallet; check it manually (${pos.mint})`)
      this.finish(pos)
      return
    }
    const state = this.d.market.get(pos.mint)
    if (state) state.watched = true
    this.reprice(pos)
    this.d.log.info(
      {
        mint: pos.mint,
        symbol: pos.symbol,
        paper: pos.paper,
        sol: lamportsToSol(pos.costLamports),
        tokens: Number(pos.tokensBought) / 1e6,
        slotsAfterLaunch: pos.slotsAfterLaunch,
        buildMs: r.timings.buildMs.toFixed(2),
        sendMs: r.timings.sendMs.toFixed(1),
        landMs: r.timings.landMs?.toFixed(0),
      },
      'position opened',
    )
    void this.journal.append({ type: 'buy', at: Date.now(), mint: pos.mint, symbol: pos.symbol, paper: pos.paper, signature: r.signature || undefined, lamports: pos.costLamports, tokens: pos.tokensBought, slot: r.slot, slotsAfterLaunch: pos.slotsAfterLaunch, timings: r.timings, simulation: r.simulation })
    if (!pos.paper && r.signature) void this.reconcile(pos, r.signature)
    this.changed(pos)
  }

  // Monitoring ----------------------------------------------------------------

  /** Called for every trade on a mint (from the market book). */
  onMarket(state: MintState): void {
    const pos = this.active.get(state.mintStr)
    if (!pos || pos.status !== 'open') return
    this.reprice(pos, state)
    this.evaluate(pos, state)
  }

  private tick(): void {
    for (const pos of this.active.values()) {
      if (pos.pending) {
        if (!pos.paper) void this.resolve(pos)
        continue
      }
      if (pos.status !== 'open') continue
      const state = this.d.market.get(pos.mint)
      this.reprice(pos, state)
      this.evaluate(pos, state)
    }
  }

  private reprice(pos: Position, state = this.d.market.get(pos.mint)): void {
    if (!state || pos.tokensHeld === 0n || pos.tokensBought === 0n) return
    if (state.complete) return // curve reserves are frozen at graduation
    const q = quoteSell(state.curve, feeRates(this.d.protocol.feeContext(), state.curve), pos.tokensHeld)
    const costHeld = (pos.costLamports * pos.tokensHeld) / pos.tokensBought
    pos.valueLamports = q.quoteOut
    pos.gainPct = costHeld > 0n ? (Number(q.quoteOut) / Number(costHeld) - 1) * 100 : 0
    if (pos.gainPct > pos.peakGainPct) pos.peakGainPct = pos.gainPct
    pos.lastPriceAt = Date.now()
    this.emit('update', pos)
  }

  private evaluate(pos: Position, state: MintState | undefined): void {
    const now = Date.now()
    if (pos.pending || this.busy.has(pos.mint) || now < pos.nextSellAt) return
    let decision: ExitDecision
    if (state?.complete) {
      decision = { action: 'sell', pct: 100, reason: 'graduated to PumpSwap', urgent: true }
    } else {
      decision = decideExit(
        {
          gainPct: pos.gainPct,
          peakGainPct: pos.peakGainPct,
          ageMs: now - pos.openedAt,
          idleMs: state ? now - state.lastTradeAtWall : now - pos.lastPriceAt,
          devSold: state?.devSold ?? false,
          tiersDone: pos.tiersDone,
          moonbag: pos.moonbag,
          books: this.books(pos),
          moonbagsFull: !pos.moonbag && this.moonbagCount >= this.d.cfg.exits.moonbag.max,
        },
        this.d.cfg.exits,
      )
    }
    if (decision.action === 'moonbag') {
      this.startMoonbag(pos, decision.reason)
      this.evaluate(pos, state)
    } else if (decision.action === 'sell') {
      void this.sell(pos.mint, decision.pct, decision.reason, decision.tier, decision.moonbag)
    }
  }

  private books(pos: Position): PositionBooks | undefined {
    if (pos.tokensBought === 0n) return undefined
    return {
      heldFraction: Number(pos.tokensHeld) / Number(pos.tokensBought),
      costLamports: Number(pos.costLamports),
      realizedLamports: Number(pos.realizedLamports),
      networkLamports: Number(pos.networkFeesLamports),
      sellNetworkLamports: Number(this.d.executor.networkFee('sell')),
    }
  }

  private startMoonbag(pos: Position, reason: string): void {
    pos.moonbag = true
    pos.moonbagAt = Date.now()
    this.d.log.info({ mint: pos.mint, symbol: pos.symbol, reason, heldPct: Math.round((Number(pos.tokensHeld) / Number(pos.tokensBought || 1n)) * 100) }, 'moonbag riding')
    void this.journal.append({ type: 'moonbag', at: pos.moonbagAt, mint: pos.mint, symbol: pos.symbol, paper: pos.paper, reason, tokens: pos.tokensHeld })
    this.changed(pos)
  }

  // Exit ----------------------------------------------------------------------

  /**
   * Sells `pct` of the remaining position, retrying with wider slippage.
   * With `moonbag`, what remains afterwards rides as the moonbag.
   */
  async sell(mint: string, pct: number, reason: string, tier?: number, moonbag = false): Promise<boolean> {
    const pos = this.active.get(mint)
    if (!pos || pos.status !== 'open' || pos.pending || this.busy.has(mint) || this.stopping) return false
    this.busy.add(mint)
    pos.status = 'closing'
    this.changed(pos)
    try {
      return await this.track(this.runSell(pos, pct, reason, tier, moonbag))
    } finally {
      this.busy.delete(mint)
      if (pos.status === 'closing') {
        pos.status = 'open'
        this.changed(pos)
      }
    }
  }

  private async runSell(pos: Position, pct: number, reason: string, tier: number | undefined, moonbag: boolean): Promise<boolean> {
    const { mint } = pos
    const { exits } = this.d.cfg
    const all = pct >= 100
    let tokens = all ? pos.tokensHeld : (pos.tokensHeld * BigInt(Math.round(pct * 100))) / 10_000n
    // Don't leave dust behind a partial sell.
    if (!all && pos.tokensHeld - tokens < pos.tokensBought / 100n) tokens = pos.tokensHeld
    if (tokens <= 0n) return false
    const sellingAll = tokens === pos.tokensHeld
    const signatures: string[] = []
    let migrationWaits = 0

    for (let attempt = 0; attempt <= exits.sellRetries; attempt++) {
      // Shutting down: no new attempts; the exit policy decides again after the restart.
      if (this.stopping) return false
      const slippageBps =
        exits.sellRetries === 0
          ? exits.sellSlippageBps
          : Math.round(exits.sellSlippageBps + ((exits.sellMaxSlippageBps - exits.sellSlippageBps) * attempt) / exits.sellRetries)
      const graduated = this.d.market.get(mint)?.complete ?? false
      // Only on the first attempt: a stray dust transfer would make the close fail.
      const closeAccount = sellingAll && exits.closeTokenAccount && attempt === 0 && !graduated
      pos.sellAttempts++
      const result = await this.d.executor.sell(
        {
          mint: new PublicKey(mint),
          tokenProgram: new PublicKey(pos.tokenProgram),
          creator: new PublicKey(this.d.market.get(mint)?.curve.creator ?? pos.creator),
          isMayhemMode: pos.isMayhemMode,
          tokens,
          slippageBps,
          closeAccount,
        },
        this.saveSubmitted(pos, 'sell', { tokens, reason, tier, moonbag }),
      )
      if (result.ok) {
        pos.pending = undefined
        this.applySell(pos, tokens, result, reason, tier, moonbag)
        this.sellRecovered(pos)
        if (pos.status === 'closed' && !closeAccount && !pos.paper && exits.closeTokenAccount) void this.closeTokenAccount(pos)
        return true
      }
      if (result.aborted) {
        this.d.log.warn({ mint, symbol: pos.symbol, signature: result.signature }, 'stopped with a sell in flight: the next start checks whether it landed')
        return false
      }
      pos.pending = undefined
      if (result.signature) signatures.push(result.signature)

      this.d.log.warn({ mint, symbol: pos.symbol, attempt, slippageBps, error: result.error }, 'sell attempt failed')
      if (result.landed) {
        pos.networkFeesLamports += result.networkFeeLamports ?? BASE_FEE_LAMPORTS + priorityLamports(this.d.cfg, 'sell')
        if (!pos.paper && result.signature) this.landedFailure(pos, result.signature)
      }
      if (pos.paper && graduated) {
        // Paper mode cannot route through the AMM: book at the last curve value.
        const paper = { ok: true, paper: true, signature: 'paper-graduated', slot: 0, tokens, lamports: pos.valueLamports, tradeFeesLamports: 0n, networkFeeLamports: this.d.executor.networkFee('sell'), timings: { buildMs: 0, sendMs: 0 } } as const
        this.applySell(pos, tokens, paper, reason, tier, moonbag)
        return true
      }
      if (/Pool account not found/i.test(result.error) && migrationWaits < 30) {
        // Migration to PumpSwap not finished yet; wait and retry without using up attempts.
        migrationWaits++
        await sleep(2_000)
        attempt--
        continue
      }
      if (!pos.paper && !result.slippage) {
        // Unknown failure: tokens may have left the wallet (an attempt that
        // was given up on landed after all).
        const onChain = await this.settledBalance(pos)
        if (onChain !== undefined && onChain < pos.tokensHeld) {
          this.bookMissing(pos, pos.tokensHeld - onChain, await this.landedAmong(signatures), reason, tier, moonbag)
          return true
        }
      }
    }
    pos.status = 'open'
    pos.error = `sell failed after ${exits.sellRetries + 1} attempts`
    // Back off before the exit policy retries: 2s, 4s, ... capped at 30s.
    const failures = Math.ceil(pos.sellAttempts / (exits.sellRetries + 1))
    pos.nextSellAt = Date.now() + Math.min(30_000, 2_000 * 2 ** Math.max(0, failures - 1))
    this.sellFailed(pos, reason)
    this.changed(pos)
    return false
  }

  async sellAll(reason: string): Promise<void> {
    await Promise.all(this.list().filter((p) => p.status === 'open' && !p.pending).map((p) => this.sell(p.mint, 100, reason)))
  }

  private sellFailed(pos: Position, reason: string): void {
    pos.sellFailures = (pos.sellFailures ?? 0) + 1
    if (pos.sellFailures !== STUCK_ALERT_ROUNDS) return
    this.alert(`⚠️ ${pos.symbol}: selling keeps failing (${STUCK_ALERT_ROUNDS} rounds, ${reason}): ${pos.error ?? 'unknown error'}. The bot keeps retrying; check the RPC and landing if this lasts.`)
  }

  private sellRecovered(pos: Position): void {
    if ((pos.sellFailures ?? 0) >= STUCK_ALERT_ROUNDS) this.alert(`✅ ${pos.symbol}: sold after all`)
    pos.sellFailures = 0
  }

  /**
   * Books tokens that left the wallet without a sale the bot saw complete. With
   * the signature of the sale that took them, reconciliation makes the P&L
   * exact; without one it stays an estimate at the last price, and the owner
   * is told to check the wallet.
   */
  private bookMissing(pos: Position, tokens: bigint, signature: string | undefined, reason: string, tier?: number, moonbag = false): void {
    if (!signature) {
      pos.estimated = 'tokens left the wallet without a sale the bot saw; proceeds estimated at the last price'
      this.alert(`⚠️ ${pos.symbol}: tokens left the wallet without a sale the bot saw; booked at the last price. Check the wallet (${pos.mint}).`)
    }
    this.reprice(pos)
    const found = { ok: true, paper: false, signature: signature ?? '', slot: 0, tokens, lamports: 0n, tradeFeesLamports: 0n, networkFeeLamports: signature ? this.d.executor.networkFee('sell') : 0n, timings: { buildMs: 0, sendMs: 0 } } as const
    this.applySell(pos, tokens, found, `${reason} (found on-chain)`, tier, moonbag)
  }

  /**
   * Token balance, read twice a moment apart and the higher one kept: right
   * after a trade the RPC can still show the balance from before it, and a
   * stale low reading must never book tokens as gone.
   */
  private async settledBalance(pos: Position): Promise<bigint | undefined> {
    const read = () => this.d.executor.tokenBalance(new PublicKey(pos.mint), new PublicKey(pos.tokenProgram)).catch(() => undefined)
    const first = await read()
    if (first === undefined || first >= pos.tokensHeld) return first
    await sleep(2_000)
    const second = await read()
    if (second === undefined) return undefined
    return second > first ? second : first
  }

  /** The newest of `signatures` that landed, if any. */
  private async landedAmong(signatures: string[]): Promise<string | undefined> {
    for (const sig of [...signatures].reverse()) {
      if ((await this.d.executor.txOutcome(sig).catch(() => 'unknown')) === 'landed') return sig
    }
    return undefined
  }

  /**
   * A full exit that could not close the token account in the same
   * transaction (a retry, or a graduated coin) leaves its rent behind:
   * close it once the account reads empty.
   */
  private async closeTokenAccount(pos: Position): Promise<void> {
    for (let i = 0; i < 3 && !this.stopping; i++) {
      await sleep(3_000)
      try {
        const r = await this.d.executor.closeTokenAccount(new PublicKey(pos.mint), new PublicKey(pos.tokenProgram))
        if (r.ok) {
          this.d.log.info({ mint: pos.mint, symbol: pos.symbol, signature: r.signature }, 'closed the empty token account')
          this.landedFailure(pos, r.signature)
          return
        }
        if (r.error !== 'the account still holds tokens') return
      } catch (err) {
        this.d.log.debug({ mint: pos.mint, err: (err as Error).message }, 'could not close the token account yet')
      }
    }
  }

  private applySell(pos: Position, tokens: bigint, r: Extract<TradeResult, { ok: true }>, reason: string, tier?: number, moonbag = false): void {
    let lamports = r.lamports
    if (lamports === 0n && !r.paper) {
      // Fill was not seen on the stream; book the expected proceeds until reconciled.
      lamports = (pos.valueLamports * tokens) / (pos.tokensHeld || 1n)
    }
    pos.tokensHeld -= tokens
    pos.realizedLamports += lamports
    pos.networkFeesLamports += r.networkFeeLamports
    pos.sells.push({ at: Date.now(), tokens, lamports, signature: r.signature, reason })
    if (!r.paper && r.signature) this.markLanded(pos, r.signature)
    if (tier !== undefined) pos.tiersDone = tier + 1
    pos.error = undefined
    this.d.log.info({ mint: pos.mint, symbol: pos.symbol, reason, sol: lamportsToSol(lamports), tokens: Number(tokens) / 1e6, paper: pos.paper }, 'sold')
    void this.journal.append({ type: 'sell', at: Date.now(), mint: pos.mint, symbol: pos.symbol, paper: pos.paper, signature: r.signature || undefined, lamports, tokens, reason, timings: r.timings, simulation: r.simulation })
    if (!r.paper && r.signature) void this.reconcile(pos, r.signature)
    if (pos.tokensHeld <= 0n) {
      pos.tokensHeld = 0n
      pos.valueLamports = 0n
      this.close(pos, reason)
    } else {
      pos.status = 'open'
      this.reprice(pos)
      if (moonbag && !pos.moonbag) this.startMoonbag(pos, reason)
      this.changed(pos)
    }
  }

  private close(pos: Position, reason: string): void {
    pos.status = 'closed'
    pos.closeReason = reason
    pos.closedAt = Date.now()
    this.finish(pos)
  }

  private finish(pos: Position): void {
    this.active.delete(pos.mint)
    this.d.market.unwatch(pos.mint)
    this.recent.unshift(pos)
    if (this.recent.length > 200) this.recent.pop()
    // Closed positions, and failed live buys (which still paid network fees), hit P&L.
    if (pos.status === 'closed' || pos.networkFeesLamports > 0n) {
      const pnl = positionPnl(pos)
      pos.bookedPnlLamports = pnl
      this.d.risk.recordRealized(pnl)
      this.totals.closed++
      if (pnl > 0n) this.totals.wins++
      else this.totals.losses++
      this.totals.netPnlLamports += pnl
      if (pnl > this.totals.bestPnlLamports) this.totals.bestPnlLamports = pnl
      if (pnl < this.totals.worstPnlLamports) this.totals.worstPnlLamports = pnl
      const held = (pos.closedAt ?? Date.now()) - pos.openedAt
      this.totals.avgHoldMs += (held - this.totals.avgHoldMs) / this.totals.closed
      if (pos.status === 'closed') {
        this.d.log.info({ mint: pos.mint, symbol: pos.symbol, reason: pos.closeReason, pnlSol: lamportsToSol(pnl), paper: pos.paper }, 'position closed')
        void this.journal.append({ type: 'close', at: Date.now(), mint: pos.mint, symbol: pos.symbol, paper: pos.paper, reason: pos.closeReason, pnlLamports: pnl, cost: pos.costLamports, realized: pos.realizedLamports, networkFees: pos.networkFeesLamports })
      }
    }
    if (!pos.paper && pos.unreconciled?.length) this.keepSettling(pos)
    this.store.schedule()
    this.emit('closed', pos)
  }

  // Accounting ----------------------------------------------------------------

  /** A transaction that executed and failed still moved the wallet (its fees): reconcile it like any other. */
  private landedFailure(pos: Position, signature: string): void {
    this.markLanded(pos, signature)
    void this.reconcile(pos, signature)
  }

  /** A new landed tx makes the wallet delta incomplete until it is reconciled too. */
  private markLanded(pos: Position, signature: string): void {
    if (pos.unreconciled?.includes(signature)) return
    pos.landedTxs++
    pos.reconciled = pos.reconciledTxs >= pos.landedTxs
    pos.unreconciled = [...(pos.unreconciled ?? []), signature]
    if (isFinished(pos)) this.keepSettling(pos)
  }

  /** A finished position stays in the file until its last transactions are reconciled. */
  private keepSettling(pos: Position): void {
    this.settling.set(settlingKey(pos), pos)
    this.store.schedule()
  }

  /**
   * Replaces estimates with the exact on-chain wallet delta once every landed
   * transaction is confirmed. If the position already closed, the booked P&L
   * (totals and daily risk) is corrected by the difference.
   */
  private async reconcile(pos: Position, signature: string): Promise<void> {
    const delta = await this.d.executor.walletDelta(signature)
    if (delta === undefined) {
      this.d.log.warn({ mint: pos.mint, signature }, 'could not reconcile transaction; P&L stays estimated')
      return
    }
    // Checked again: a restart may have retried it while this one was still waiting.
    if (!pos.unreconciled?.includes(signature)) return
    pos.walletDeltaLamports = (pos.walletDeltaLamports ?? 0n) + delta
    pos.unreconciled = pos.unreconciled.filter((s) => s !== signature)
    pos.reconciledTxs++
    if (!pos.unreconciled.length && this.settling.delete(settlingKey(pos))) this.store.schedule()
    pos.reconciled = pos.reconciledTxs >= pos.landedTxs
    if (pos.reconciled && pos.bookedPnlLamports !== undefined) {
      const exact = positionPnl(pos)
      const correction = exact - pos.bookedPnlLamports
      if (correction !== 0n) {
        const wasWin = pos.bookedPnlLamports > 0n
        this.totals.netPnlLamports += correction
        this.d.risk.recordRealized(correction)
        if (wasWin !== exact > 0n) {
          this.totals.wins += wasWin ? -1 : 1
          this.totals.losses += wasWin ? 1 : -1
        }
        pos.bookedPnlLamports = exact
        void this.journal.append({ type: 'reconcile', at: Date.now(), mint: pos.mint, pnlLamports: exact, correctionLamports: correction })
        this.emit('reconciled', pos, correction)
      }
    }
    this.changed(pos)
  }

  private changed(pos: Position): void {
    this.store.schedule()
    this.emit('update', pos)
  }

  private alert(message: string): void {
    this.d.log.warn(message)
    this.emit('alert', message)
  }

  private track<T>(p: Promise<T>): Promise<T> {
    const tracked: Promise<T> = p.finally(() => this.inflight.delete(tracked))
    this.inflight.add(tracked)
    return tracked
  }

  // Restore -------------------------------------------------------------------

  /**
   * Reloads the positions after a restart and re-seeds their live curve
   * state. Live positions are checked against the chain before they trade
   * again: a buy or sell in flight at the stop may have landed since, and
   * after a crash the saved holdings may be out of date.
   */
  private async restore(): Promise<void> {
    const saved = await readJson<Record<string, unknown>[]>(join(this.d.cfg.dataDir, 'positions.json'))
    if (!saved?.length) return
    const restored: Position[] = []
    for (const raw of saved) {
      const pos = reviveBigints(raw) as unknown as Position
      if (pos.paper !== this.d.executor.paper) {
        this.foreign.push(raw)
        continue
      }
      if (isFinished(pos)) {
        // Closed before the stop, its last reconciliations cut off: finish them.
        if (!pos.paper && pos.unreconciled?.length) {
          this.settling.set(settlingKey(pos), pos)
          for (const sig of pos.unreconciled) void this.reconcile(pos, sig)
        }
        continue
      }
      if (pos.paper) {
        if (pos.status === 'opening') continue // a paper buy ends with the process
        pos.pending = undefined
      } else if (!pos.pending) {
        pos.pending = pos.status === 'opening' ? { side: 'buy', since: pos.openedAt } : { side: 'sync', since: Date.now() }
      }
      pos.status = pos.pending?.side === 'buy' ? 'opening' : 'open'
      pos.nextSellAt = 0
      pos.nextResolveAt = 0
      restored.push(pos)
    }
    // All at once: a slow RPC must not stretch the start by the number of positions.
    await Promise.all(restored.map((pos) => this.seedCurve(pos)))
    for (const pos of restored) {
      this.active.set(pos.mint, pos)
      this.d.log.info({ mint: pos.mint, symbol: pos.symbol, check: pos.pending?.side }, 'restored position')
    }
    if (this.foreign.length) {
      const mode = this.d.executor.paper ? 'live' : 'paper'
      const bags = this.foreign.filter((p) => (p as { moonbag?: boolean }).moonbag).length
      this.alert(
        `⚠️ ${this.foreign.length} ${mode} position(s)${bags ? ` (${bags} moonbag(s))` : ''} from before DRY_RUN changed are kept but not managed; switch back to manage them.`,
      )
    }
    await Promise.all(restored.filter((pos) => pos.pending).map((pos) => this.resolve(pos)))
    // Reconciliations the last stop cut off.
    for (const pos of restored) if (!pos.paper) for (const sig of pos.unreconciled ?? []) void this.reconcile(pos, sig)
  }

  private async seedCurve(pos: Position): Promise<void> {
    try {
      const acct = await this.d.rpc.getAccountInfo(bondingCurvePda(new PublicKey(pos.mint)))
      if (acct) this.d.market.seed(new PublicKey(pos.mint), curveFromAccount(decodeBondingCurve(acct.data)), 0)
    } catch (err) {
      this.d.log.warn({ mint: pos.mint, err: (err as Error).message }, 'could not refresh curve for restored position')
    }
  }

  /** Settles a pending position on-chain; retried from the tick until it succeeds. */
  private async resolve(pos: Position): Promise<void> {
    const p = pos.pending
    if (!p || this.busy.has(pos.mint) || Date.now() < (pos.nextResolveAt ?? 0)) return
    this.busy.add(pos.mint)
    try {
      await this.track(this.settle(pos, p))
      if ((pos.resolveFailures ?? 0) >= UNSETTLED_ALERT_TRIES) this.alert(`✅ ${pos.symbol}: checked on-chain again; managed as usual`)
      pos.resolveFailures = 0
    } catch (err) {
      pos.nextResolveAt = Date.now() + (this.d.retryMs ?? 10_000)
      pos.resolveFailures = (pos.resolveFailures ?? 0) + 1
      this.d.log.warn({ mint: pos.mint, err: (err as Error).message, tries: pos.resolveFailures }, 'could not check the position on-chain yet; retrying')
      if (pos.resolveFailures === UNSETTLED_ALERT_TRIES) {
        this.alert(`⚠️ ${pos.symbol}: cannot check this position on-chain (${(err as Error).message}); it is not traded until it can, so no stop-loss meanwhile. Retrying every 10 s.`)
      }
    } finally {
      this.busy.delete(pos.mint)
    }
  }

  private async settle(pos: Position, p: PendingTx): Promise<void> {
    // RPC errors throw: an unreadable balance is never taken for an empty one.
    const balance = await this.d.executor.tokenBalance(new PublicKey(pos.mint), new PublicKey(pos.tokenProgram))
    const outcome = p.signature ? await this.d.executor.txOutcome(p.signature) : 'unknown'
    const mayStillLand = async () =>
      outcome === 'unknown' && (p.lastValidBlockHeight ? !(await this.d.executor.expired(p.lastValidBlockHeight)) : Date.now() - p.since < UNKNOWN_TX_MS)

    if (p.side === 'buy') {
      if (balance > 0n) {
        pos.pending = undefined
        if (!p.signature) pos.estimated = 'buy found on-chain after a restart; its cost is the amount that was sent'
        this.d.log.info({ mint: pos.mint, symbol: pos.symbol, tokens: balance.toString() }, 'buy from before the restart landed')
        this.applyBuy(pos, { ok: true, paper: false, signature: p.signature ?? '', slot: 0, tokens: balance, lamports: 0n, tradeFeesLamports: 0n, networkFeeLamports: this.d.executor.networkFee('buy'), timings: { buildMs: 0, sendMs: 0 } })
        return
      }
      if (await mayStillLand()) {
        pos.nextResolveAt = Date.now() + 3_000
        return
      }
      pos.pending = undefined
      pos.status = 'failed'
      pos.closedAt = Date.now()
      pos.costLamports = 0n
      if (outcome === 'failed') {
        pos.error = 'buy failed on-chain (found after a restart)'
        pos.networkFeesLamports = BASE_FEE_LAMPORTS + priorityLamports(this.d.cfg, 'buy')
      } else if (outcome === 'landed') {
        pos.error = 'buy landed but no tokens are in the wallet'
        this.alert(`⚠️ ${pos.symbol}: a buy from before the restart landed but no tokens are in the wallet; check it manually (${pos.mint})`)
      } else {
        pos.error = 'buy never landed'
      }
      this.finish(pos)
      return
    }

    if (balance >= pos.tokensHeld) {
      if (p.side === 'sell' && (await mayStillLand())) {
        pos.nextResolveAt = Date.now() + 3_000
        return
      }
      pos.pending = undefined
      this.changed(pos)
      return
    }
    pos.pending = undefined
    const sold = p.side === 'sell' && outcome === 'landed'
    this.bookMissing(pos, pos.tokensHeld - balance, sold ? p.signature : undefined, p.reason ?? 'sold before the restart', sold ? p.tier : undefined, sold ? p.moonbag : false)
  }
}

const isFinished = (p: Position) => p.status === 'closed' || p.status === 'failed'
const settlingKey = (p: Position) => `${p.mint}:${p.openedAt}`

const BIGINT_FIELDS = new Set([
  'costLamports',
  'tokensBought',
  'tokensHeld',
  'realizedLamports',
  'networkFeesLamports',
  'walletDeltaLamports',
  'bookedPnlLamports',
  'valueLamports',
  'tokens',
  'lamports',
])

/** Inverse of the JSON replacer for the bigint fields of persisted positions. */
function reviveBigints(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((v) => reviveBigints(v))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = reviveBigints(v, k)
    return out
  }
  if (typeof value === 'string' && BIGINT_FIELDS.has(key) && /^-?\d+$/.test(value)) return BigInt(value)
  return value
}
