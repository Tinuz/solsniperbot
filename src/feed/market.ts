import { EventEmitter } from 'node:events'
import { EARLY_WINDOW_MS } from '../strategy/momentum.js'
import { PublicKey } from '@solana/web3.js'
import { type CurveState, buyCostForTokens, feeRates, quoteBuyExactIn } from '../pump/curve.js'
import type { CreateEvent, TradeEvent } from '../pump/events.js'
import { isSolQuote } from '../pump/events.js'
import { holderRewardsPda } from '../pump/pda.js'
import type { PumpProtocol } from '../pump/protocol.js'
import { LruCache } from '../util/lru.js'
import type { FeedSource, FeedTx, LaunchPreview } from './types.js'

/** A newly created coin, with the curve as it stands after the create transaction. */
export interface Launch {
  mint: PublicKey
  mintStr: string
  name: string
  symbol: string
  uri: string
  /** `bonding_curve.creator`: whose vault receives creator fees. */
  creator: PublicKey
  /** Signer of the create transaction. */
  dev: PublicKey
  tokenProgram: PublicKey
  isMayhemMode: boolean
  isHolderReward: boolean
  quoteMint: PublicKey
  isSolPaired: boolean
  curve: CurveState
  /** Quote the create transaction's own buys put into the curve (lamports, excl. fees). */
  devBuyLamports: bigint
  devBuyTokens: bigint
  signature: string
  slot: number
  /** `performance.now()` at detection. */
  detectedAt: number
  detectedAtWall: number
  source: FeedSource
  /** False for shred previews, which have not executed yet. */
  executed: boolean
}

export interface MintState {
  mintStr: string
  launch?: Launch
  curve: CurveState
  curveSlot: number
  complete: boolean
  pool?: string
  createdAtWall: number
  lastTradeAtWall: number
  trades: number
  buys: number
  sells: number
  /** Lamports into / out of the curve, excluding fees. */
  buyVolume: bigint
  sellVolume: bigint
  buyers: Set<string>
  /** Net token balance per wallet from observed trades (bounded). */
  holders: Map<string, bigint>
  /** Lamports other wallets bought within EARLY_WINDOW_MS of detection (bundled with the launch). */
  earlyBuyVolume: bigint
  devStr?: string
  devSold: boolean
  watched: boolean
}

const MAX_WALLETS_PER_MINT = 2_000

export interface MarketEvents {
  launch: [launch: Launch, state: MintState]
  trade: [state: MintState, trade: TradeEvent, tx: FeedTx]
  complete: [state: MintState]
  migration: [state: MintState]
}

/**
 * Live per-mint market state built purely from the event stream.
 *
 * Every pump trade carries the curve's post-trade reserves, so prices,
 * volumes, buyer counts and dev activity are known the moment a transaction
 * is processed, with no polling.
 */
export class MarketBook extends EventEmitter<MarketEvents> {
  private readonly mints = new LruCache<string, MintState>(25_000)

  constructor(private readonly protocol: PumpProtocol) {
    super()
  }

  get size(): number {
    return this.mints.size
  }

  get(mint: string): MintState | undefined {
    return this.mints.peek(mint)
  }

  /** Starts tracking a mint that was created before the bot saw it (restored or manual positions). */
  seed(mint: PublicKey, curve: CurveState, slot: number): MintState {
    const key = mint.toBase58()
    const existing = this.mints.get(key)
    if (existing) {
      existing.watched = true
      if (slot >= existing.curveSlot) {
        existing.curve = curve
        existing.curveSlot = slot
      }
      return existing
    }
    const state = this.newState(key, curve, slot, Date.now())
    state.watched = true
    state.complete = curve.complete
    this.mints.set(key, state)
    return state
  }

  unwatch(mint: string): void {
    const s = this.mints.peek(mint)
    if (s) s.watched = false
  }

  ingest(tx: FeedTx): void {
    if (tx.err || tx.events.length === 0) return
    let created: { ev: CreateEvent; state: MintState } | undefined
    let devBuyLamports = 0n
    let devBuyTokens = 0n
    let devBuyCreator: PublicKey | undefined

    for (const ev of tx.events) {
      switch (ev.kind) {
        case 'create': {
          const key = ev.mint.toBase58()
          const creator = ev.isHolderReward ? holderRewardsPda(ev.mint) : ev.creator
          const curve: CurveState = {
            virtualTokenReserves: ev.virtualTokenReserves,
            virtualQuoteReserves: isSolQuote(ev.quoteMint) ? ev.virtualSolReserves : ev.virtualQuoteReserves,
            realTokenReserves: ev.realTokenReserves,
            realQuoteReserves: 0n,
            tokenTotalSupply: ev.tokenTotalSupply,
            complete: false,
            creator,
            isMayhemMode: ev.isMayhemMode,
            creatorFeeBps: ev.creatorFeeBps,
          }
          const existing = this.mints.peek(key)
          const state = existing ?? this.newState(key, curve, tx.slot, Date.now())
          // A shred preview may have created the entry already; executed data wins.
          state.curve = curve
          state.curveSlot = tx.slot
          state.devStr = ev.user.toBase58()
          if (!existing) this.mints.set(key, state)
          created = { ev, state }
          break
        }
        case 'trade': {
          const key = ev.mint.toBase58()
          const state = this.mints.get(key)
          if (!state) break
          this.applyTrade(state, ev, tx.slot)
          if (created && created.state === state && ev.isBuy) {
            devBuyLamports += ev.solAmount
            devBuyTokens += ev.tokenAmount
            if (!ev.creator.equals(PublicKey.default)) devBuyCreator = ev.creator
          } else {
            this.emit('trade', state, ev, tx)
          }
          break
        }
        case 'complete': {
          const state = this.mints.get(ev.mint.toBase58())
          if (state) {
            state.complete = true
            state.curve = { ...state.curve, complete: true }
            this.emit('complete', state)
          }
          break
        }
        case 'migration': {
          const state = this.mints.get(ev.mint.toBase58())
          if (state) {
            state.complete = true
            state.pool = ev.pool.toBase58()
            this.emit('migration', state)
          }
          break
        }
      }
    }

    if (created) {
      const { ev, state } = created
      if (devBuyCreator) state.curve = { ...state.curve, creator: devBuyCreator }
      if (state.launch) {
        // Already announced from shreds; refresh with executed values.
        state.launch = { ...state.launch, curve: state.curve, creator: state.curve.creator, executed: true, devBuyLamports, devBuyTokens }
        return
      }
      const launch: Launch = {
        mint: ev.mint,
        mintStr: state.mintStr,
        name: ev.name,
        symbol: ev.symbol,
        uri: ev.uri,
        creator: state.curve.creator,
        dev: ev.user,
        tokenProgram: ev.tokenProgram,
        isMayhemMode: ev.isMayhemMode,
        isHolderReward: ev.isHolderReward,
        quoteMint: ev.quoteMint,
        isSolPaired: isSolQuote(ev.quoteMint),
        curve: state.curve,
        devBuyLamports,
        devBuyTokens,
        signature: tx.signature,
        slot: tx.slot,
        detectedAt: tx.receivedAt,
        detectedAtWall: Date.now(),
        source: tx.source,
        executed: true,
      }
      state.launch = launch
      this.emit('launch', launch, state)
    }
  }

  /**
   * Announces a launch seen in shreds. The curve after the dev's buy is
   * reconstructed from the create/buy instruction arguments.
   */
  ingestPreview(p: LaunchPreview): void {
    const c = p.create
    const key = c.mint.toBase58()
    if (this.mints.peek(key)) return
    const creator = c.isHolderReward ? holderRewardsPda(c.mint) : c.creator
    let curve = this.protocol.initialCurve(creator, c.isMayhemMode)
    let devBuyLamports = 0n
    let devBuyTokens = 0n
    for (const b of p.buys) {
      let tokens: bigint
      if (b.spendableQuote !== undefined) {
        tokens = quoteBuyExactIn(curve, feeRates(this.protocol.feeContext(), curve), b.spendableQuote).tokensOut
      } else {
        tokens = b.tokenAmount ?? 0n
      }
      if (tokens > curve.realTokenReserves) tokens = curve.realTokenReserves
      const cost = buyCostForTokens(curve, tokens)
      curve = {
        ...curve,
        virtualTokenReserves: curve.virtualTokenReserves - tokens,
        virtualQuoteReserves: curve.virtualQuoteReserves + cost,
        realTokenReserves: curve.realTokenReserves - tokens,
        realQuoteReserves: curve.realQuoteReserves + cost,
      }
      devBuyLamports += cost
      devBuyTokens += tokens
    }
    const state = this.newState(key, curve, p.slot, Date.now())
    state.devStr = c.user.toBase58()
    const launch: Launch = {
      mint: c.mint,
      mintStr: key,
      name: c.name,
      symbol: c.symbol,
      uri: c.uri,
      creator,
      dev: c.user,
      tokenProgram: c.tokenProgram,
      isMayhemMode: c.isMayhemMode,
      isHolderReward: c.isHolderReward,
      quoteMint: c.quoteMint,
      isSolPaired: isSolQuote(c.quoteMint),
      curve,
      devBuyLamports,
      devBuyTokens,
      signature: p.signature,
      slot: p.slot,
      detectedAt: p.receivedAt,
      detectedAtWall: Date.now(),
      source: 'deshred',
      executed: false,
    }
    state.launch = launch
    this.mints.set(key, state)
    this.emit('launch', launch, state)
  }

  /** Drops idle, unwatched mints. */
  prune(maxIdleMs: number, now = Date.now()): number {
    let dropped = 0
    for (const [key, s] of [...this.mints.entries()]) {
      if (!s.watched && now - Math.max(s.lastTradeAtWall, s.createdAtWall) > maxIdleMs) {
        this.mints.delete(key)
        dropped++
      }
    }
    return dropped
  }

  private newState(mintStr: string, curve: CurveState, slot: number, now: number): MintState {
    return {
      mintStr,
      curve,
      curveSlot: slot,
      complete: false,
      createdAtWall: now,
      lastTradeAtWall: now,
      trades: 0,
      buys: 0,
      sells: 0,
      buyVolume: 0n,
      sellVolume: 0n,
      buyers: new Set(),
      holders: new Map(),
      earlyBuyVolume: 0n,
      devSold: false,
      watched: false,
    }
  }

  private applyTrade(state: MintState, ev: TradeEvent, slot: number): void {
    const sol = isSolQuote(ev.quoteMint)
    if (slot >= state.curveSlot) {
      state.curve = {
        ...state.curve,
        virtualTokenReserves: ev.virtualTokenReserves,
        virtualQuoteReserves: sol ? ev.virtualSolReserves : ev.virtualQuoteReserves || ev.virtualSolReserves,
        realTokenReserves: ev.realTokenReserves,
        realQuoteReserves: sol ? ev.realSolReserves : ev.realQuoteReserves || ev.realSolReserves,
        creator: ev.creator.equals(PublicKey.default) ? state.curve.creator : ev.creator,
        isMayhemMode: ev.mayhemMode,
      }
      state.curveSlot = slot
    }
    state.trades++
    state.lastTradeAtWall = Date.now()
    const user = ev.user.toBase58()
    const prev = state.holders.get(user) ?? 0n
    if (ev.isBuy) {
      state.buys++
      state.buyVolume += ev.solAmount
      if (user !== state.devStr && state.launch && Date.now() - state.launch.detectedAtWall <= EARLY_WINDOW_MS) state.earlyBuyVolume += ev.solAmount
      if (state.buyers.size < MAX_WALLETS_PER_MINT) state.buyers.add(user)
      if (state.holders.size < MAX_WALLETS_PER_MINT || state.holders.has(user)) state.holders.set(user, prev + ev.tokenAmount)
    } else {
      state.sells++
      state.sellVolume += ev.solAmount
      if (state.holders.has(user)) state.holders.set(user, prev > ev.tokenAmount ? prev - ev.tokenAmount : 0n)
      if (user === state.devStr) state.devSold = true
    }
  }
}
