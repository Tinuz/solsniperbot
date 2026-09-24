import { Keypair, type PublicKey, type TransactionInstruction } from '@solana/web3.js'
import type { Config } from '../config.js'
import type { MarketBook } from '../feed/market.js'
import type { FeedTx } from '../feed/types.js'
import { type CurveState, feeRates, quoteBuyExactIn, quoteSell, withSlippageDown } from '../pump/curve.js'
import { type TradeEvent, parsePumpLogs } from '../pump/events.js'
import {
  type TradeAccounts,
  buyExactQuoteInV2Ix,
  closeTokenAccountIx,
  createAtaIdempotentIx,
  sellV2Ix,
} from '../pump/instructions.js'
import { associatedTokenAddress } from '../pump/pda.js'
import type { PumpProtocol } from '../pump/protocol.js'
import type { BlockhashCache } from '../solana/blockhash.js'
import type { SignatureTracker } from '../solana/confirm.js'
import type { Lander, SendResult } from '../solana/landing.js'
import type { PriorityFees, Side } from '../solana/priority-fee.js'
import type { RpcClient } from '../solana/rpc.js'
import { type BuiltTx, buildTransaction } from '../solana/tx.js'
import type { Logger } from '../util/logger.js'
import { nowMs, sleep } from '../util/time.js'
import type { AmmSeller } from './amm.js'
import { describeTxError, isCurveCompleteError, isSlippageError } from './errors.js'

export interface Timings {
  /** Decision to signed bytes. */
  buildMs: number
  /** Signed bytes to first submission path accepting them. */
  sendMs: number
  /** Submission to observed landing. */
  landMs?: number
}

export interface SimulationReport {
  predictedTokens?: bigint
  simulatedTokens?: bigint
  predictedLamports?: bigint
  simulatedLamports?: bigint
  unitsConsumed?: number
  err?: string
}

export type TradeResult =
  | {
      ok: true
      paper: boolean
      signature: string
      slot: number
      tokens: bigint
      /** Buys: lamports paid incl. trade fees. Sells: lamports received after trade fees. */
      lamports: bigint
      tradeFeesLamports: bigint
      timings: Timings
      simulation?: SimulationReport
    }
  | {
      ok: false
      error: string
      signature?: string
      /** True when the transaction executed on-chain and failed (its fees were paid). */
      landed?: boolean
      slippage?: boolean
      curveComplete?: boolean
      timings?: Timings
    }

export interface BuyRequest {
  mint: PublicKey
  tokenProgram: PublicKey
  creator: PublicKey
  isMayhemMode: boolean
  /** Curve at decision time; the slippage floor is computed from it. */
  curve: CurveState
  lamports: bigint
  slippageBps: number
}

export interface SellRequest {
  mint: PublicKey
  tokenProgram: PublicKey
  creator: PublicKey
  isMayhemMode: boolean
  tokens: bigint
  slippageBps: number
  closeAccount: boolean
}

interface Deps {
  cfg: Config
  rpc: RpcClient
  protocol: PumpProtocol
  market: MarketBook
  blockhash: BlockhashCache
  fees: PriorityFees
  tracker: SignatureTracker
  lander?: Lander
  amm: AmmSeller
  wallet?: Keypair
  log: Logger
}

let paperSeq = 0
const paperSig = () => `paper-${Date.now().toString(36)}-${(++paperSeq).toString(36)}`

/**
 * Builds, signs and lands trades. In paper mode it fills against the live
 * curve after a configurable latency, so paper results include the slippage a
 * real order would have suffered.
 */
export class Executor {
  private readonly fills = new Map<string, { mint: string; trade?: TradeEvent }>()
  private readonly user: PublicKey
  private readonly signer: Keypair

  constructor(private readonly d: Deps) {
    this.signer = d.wallet ?? Keypair.generate()
    this.user = this.signer.publicKey
  }

  get paper(): boolean {
    return this.d.cfg.dryRun
  }

  get walletAddress(): PublicKey {
    return this.user
  }

  /** Feed hook: captures our own fills (exact token/lamport amounts) from the stream. */
  onFeedTx(tx: FeedTx): void {
    const pending = this.fills.get(tx.signature)
    if (!pending || tx.err) return
    for (const ev of tx.events) {
      if (ev.kind === 'trade' && ev.user.equals(this.user) && ev.mint.toBase58() === pending.mint) {
        pending.trade = ev
        return
      }
    }
  }

  async buy(req: BuyRequest): Promise<TradeResult> {
    const t0 = nowMs()
    const rates = feeRates(this.d.protocol.feeContext(), req.curve)
    const expected = quoteBuyExactIn(req.curve, rates, req.lamports)
    const minTokensOut = withSlippageDown(expected.tokensOut, req.slippageBps)
    if (minTokensOut <= 0n) return { ok: false, error: 'quote returned zero tokens' }

    if (this.paper) return this.paperBuy(req, expected.tokensOut, minTokensOut, t0)

    const ixs = [
      createAtaIdempotentIx(this.user, this.user, req.mint, req.tokenProgram),
      buyExactQuoteInV2Ix(this.accounts(req), req.lamports, minTokensOut),
    ]
    return this.submit('buy', req.mint, req.tokenProgram, ixs, t0)
  }

  async sell(req: SellRequest): Promise<TradeResult> {
    const t0 = nowMs()
    const key = req.mint.toBase58()
    const state = this.d.market.get(key)
    if (state?.complete) return this.sellOnAmm(req, t0)
    if (!state) return { ok: false, error: 'no live curve state for mint' }

    const rates = feeRates(this.d.protocol.feeContext(), state.curve)
    const expected = quoteSell(state.curve, rates, req.tokens)
    const minOut = withSlippageDown(expected.quoteOut, req.slippageBps)

    if (this.paper) return this.paperSell(req, expected.quoteOut, minOut, t0)

    const ixs: TransactionInstruction[] = [sellV2Ix(this.accounts(req), req.tokens, minOut)]
    if (req.closeAccount) {
      const ata = associatedTokenAddress(this.user, req.mint, req.tokenProgram)
      ixs.push(closeTokenAccountIx(ata, this.user, this.user, req.tokenProgram))
    }
    return this.submit('sell', req.mint, req.tokenProgram, ixs, t0)
  }

  /** On-chain token balance of our ATA (base units), 0 if it does not exist. */
  async tokenBalance(mint: PublicKey, tokenProgram: PublicKey): Promise<bigint> {
    if (this.paper) return 0n
    return (await this.d.rpc.getTokenAccountBalance(associatedTokenAddress(this.user, mint, tokenProgram))) ?? 0n
  }

  /**
   * Exact lamport change for our wallet in a landed transaction: trade,
   * network fee, priority fee, tip and rent all included. Retries while the
   * transaction propagates to `confirmed`.
   */
  async walletDelta(signature: string): Promise<bigint | undefined> {
    if (this.paper) return undefined
    for (let i = 0; i < 12; i++) {
      try {
        const r = await this.d.rpc.getBalanceDelta(signature, this.user)
        if (r) return r.delta
      } catch {
        // not yet available
      }
      await sleep(1_500)
    }
    return undefined
  }

  // Internals -------------------------------------------------------------------

  private accounts(r: { mint: PublicKey; creator: PublicKey; tokenProgram: PublicKey; isMayhemMode: boolean }): TradeAccounts {
    return {
      mint: r.mint,
      user: this.user,
      creator: r.creator,
      tokenProgram: r.tokenProgram,
      feeRecipient: this.d.protocol.feeRecipient(r.isMayhemMode),
      buybackFeeRecipient: this.d.protocol.buybackFeeRecipient(),
    }
  }

  private build(side: Side, ixs: TransactionInstruction[]): BuiltTx {
    const { cfg, fees, lander, blockhash } = this.d
    const cu = side === 'buy' ? cfg.buyComputeUnits : cfg.sellComputeUnits
    const tipLamports = side === 'buy' ? cfg.buyTipLamports : cfg.sellTipLamports
    return buildTransaction({
      payer: this.signer,
      instructions: ixs,
      computeUnits: cu,
      microLamportsPerCu: fees.microLamportsPerCu(side, cu),
      blockhash: blockhash.get(),
      tip: lander?.tipsEnabled && tipLamports > 0n ? { account: lander.tipAccount(), lamports: tipLamports } : undefined,
    })
  }

  private async submit(side: Side, mint: PublicKey, tokenProgram: PublicKey, ixs: TransactionInstruction[], t0: number): Promise<TradeResult> {
    const { tracker, lander, log } = this.d
    if (!lander) return { ok: false, error: 'no submission paths configured' }
    let tx: BuiltTx
    try {
      tx = this.build(side, ixs)
    } catch (e) {
      return { ok: false, error: `build failed: ${(e as Error).message}` }
    }
    const built = nowMs()
    this.fills.set(tx.signature, { mint: mint.toBase58() })
    const outcome = tracker.track(tx.signature, tx.lastValidBlockHeight, tx.base64)

    let sends: SendResult[]
    try {
      sends = await lander.broadcast(tx.base64, tx.signature)
    } catch (e) {
      sends = [{ target: 'all', ok: false, ms: 0, error: (e as Error).message }]
    }
    const sent = nowMs()
    const accepted = sends.find((s) => s.ok)
    log.debug({ side, sig: tx.signature, accepted: accepted?.target, sends }, 'transaction submitted')

    const result = await outcome
    const landed = nowMs()
    const fill = this.fills.get(tx.signature)
    this.fills.delete(tx.signature)
    const timings: Timings = { buildMs: built - t0, sendMs: sent - built, landMs: landed - sent }

    if (result.status === 'expired') {
      return { ok: false, error: accepted ? 'transaction expired before landing' : `rejected by all paths: ${sends.map((s) => s.error).join('; ')}`, signature: tx.signature, timings }
    }
    if (result.status === 'failed') {
      return {
        ok: false,
        error: describeTxError(result.err),
        signature: tx.signature,
        landed: true,
        slippage: isSlippageError(result.err),
        curveComplete: isCurveCompleteError(result.err),
        timings,
      }
    }

    const trade = fill?.trade
    if (trade) {
      const fees = trade.fee + trade.creatorFee
      return {
        ok: true,
        paper: false,
        signature: tx.signature,
        slot: result.slot,
        tokens: trade.tokenAmount,
        lamports: side === 'buy' ? trade.solAmount + fees : trade.solAmount - fees,
        tradeFeesLamports: fees,
        timings,
      }
    }

    // The stream missed our fill; fall back to on-chain balances. Exact
    // lamport accounting follows via walletDelta().
    const tokens = side === 'buy' ? await this.landedTokenBalance(mint, tokenProgram) : 0n
    return { ok: true, paper: false, signature: tx.signature, slot: result.slot, tokens, lamports: 0n, tradeFeesLamports: 0n, timings }
  }

  /** Polls our ATA briefly: the RPC may lag the stream that reported the landing. */
  private async landedTokenBalance(mint: PublicKey, tokenProgram: PublicKey): Promise<bigint> {
    for (let i = 0; i < 5; i++) {
      const bal = await this.d.rpc.getTokenAccountBalance(associatedTokenAddress(this.user, mint, tokenProgram)).catch(() => null)
      if (bal !== null && bal > 0n) return bal
      await sleep(400)
    }
    return 0n
  }

  private async sellOnAmm(req: SellRequest, t0: number): Promise<TradeResult> {
    if (this.paper) {
      return { ok: false, error: 'paper mode cannot fill graduated (AMM) sells; position marked closed at last curve value' }
    }
    try {
      const ixs = await this.d.amm.sellInstructions(req.mint, this.user, req.tokens, req.slippageBps)
      return await this.submit('sell', req.mint, req.tokenProgram, ixs, t0)
    } catch (e) {
      return { ok: false, error: `AMM sell failed: ${(e as Error).message}` }
    }
  }

  private async paperBuy(req: BuyRequest, predicted: bigint, minTokensOut: bigint, t0: number): Promise<TradeResult> {
    // Simulation (if enabled) runs alongside the latency window so it never delays the fill.
    const simulating = this.maybeSimulate('buy', req.mint, () => [
      createAtaIdempotentIx(this.user, this.user, req.mint, req.tokenProgram),
      buyExactQuoteInV2Ix(this.accounts(req), req.lamports, minTokensOut),
    ])
    const built = nowMs()
    await sleep(this.d.cfg.paperLatencyMs)
    // Fill against whatever the curve looks like after our simulated latency.
    const curve = this.d.market.get(req.mint.toBase58())?.curve ?? req.curve
    const rates = feeRates(this.d.protocol.feeContext(), curve)
    const q = quoteBuyExactIn(curve, rates, req.lamports)
    const timings = { buildMs: built - t0, sendMs: 0, landMs: nowMs() - built }
    const simulation = await simulating
    if (simulation) simulation.predictedTokens = predicted
    if (q.tokensOut < minTokensOut) {
      return { ok: false, error: 'paper fill: slippage exceeded (curve moved during latency)', slippage: true, timings }
    }
    return {
      ok: true,
      paper: true,
      signature: paperSig(),
      slot: this.d.market.get(req.mint.toBase58())?.curveSlot ?? 0,
      tokens: q.tokensOut,
      lamports: q.netQuote + q.fees,
      tradeFeesLamports: q.fees,
      timings,
      simulation,
    }
  }

  private async paperSell(req: SellRequest, predicted: bigint, minOut: bigint, t0: number): Promise<TradeResult> {
    const simulating = this.maybeSimulate('sell', req.mint, () => [sellV2Ix(this.accounts(req), req.tokens, minOut)])
    const built = nowMs()
    await sleep(this.d.cfg.paperLatencyMs)
    const state = this.d.market.get(req.mint.toBase58())
    if (!state) return { ok: false, error: 'no live curve state for mint' }
    const q = quoteSell(state.curve, feeRates(this.d.protocol.feeContext(), state.curve), req.tokens)
    const timings = { buildMs: built - t0, sendMs: 0, landMs: nowMs() - built }
    const simulation = await simulating
    if (simulation) simulation.predictedLamports = predicted
    if (q.quoteOut < minOut) return { ok: false, error: 'paper fill: slippage exceeded', slippage: true, timings }
    return {
      ok: true,
      paper: true,
      signature: paperSig(),
      slot: state.curveSlot,
      tokens: req.tokens,
      lamports: q.quoteOut,
      tradeFeesLamports: q.fees,
      timings,
      simulation,
    }
  }

  /**
   * Paper mode with SIMULATE_DRY_RUN: runs the exact transaction the live bot
   * would send through `simulateTransaction`, proving the instruction encoding
   * against the real program and measuring compute units.
   */
  private async maybeSimulate(side: Side, mint: PublicKey, ixs: () => TransactionInstruction[]): Promise<SimulationReport | undefined> {
    if (!this.d.cfg.simulateDryRun || !this.d.wallet) return undefined
    try {
      const tx = this.build(side, ixs())
      const sim = await this.d.rpc.simulateTransaction(tx.base64)
      const report: SimulationReport = { unitsConsumed: sim.unitsConsumed }
      if (sim.err) report.err = describeTxError(sim.err)
      const mintStr = mint.toBase58()
      const trade = parsePumpLogs(sim.logs).find((e): e is TradeEvent => e.kind === 'trade' && e.mint.toBase58() === mintStr)
      if (trade) {
        report.simulatedTokens = trade.tokenAmount
        report.simulatedLamports = side === 'buy' ? trade.solAmount + trade.fee + trade.creatorFee : trade.solAmount - trade.fee - trade.creatorFee
      }
      return report
    } catch (e) {
      return { err: `simulation request failed: ${(e as Error).message}` }
    }
  }
}
