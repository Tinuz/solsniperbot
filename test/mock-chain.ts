import { createPublicKey, verify } from 'node:crypto'
import { type IncomingMessage, type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Keypair, PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  COMPUTE_BUDGET_PROGRAM_ID,
  EVENT,
  IX,
  NATIVE_MINT,
  PUMP_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '../src/pump/constants.js'
import {
  type CurveState,
  applySell,
  buyCostForTokens,
  ceilDiv,
  quoteBuyExactIn,
  quoteSell,
} from '../src/pump/curve.js'
import { FEE_CONFIG_PDA, GLOBAL_PDA, associatedTokenAddress, bondingCurvePda } from '../src/pump/pda.js'
import { discriminatorEquals } from '../src/util/borsh.js'
import { bn, encodeAccount, feesCoder, pumpCoder } from './helpers.js'

const PROTOCOL_BPS = 95n
const CREATOR_BPS = 30n
const RATES = { protocolBps: PROTOCOL_BPS, creatorBps: CREATOR_BPS }
const P = PUMP_PROGRAM_ID.toBase58()
const key = () => Keypair.generate().publicKey

interface CoinState {
  mint: PublicKey
  creator: PublicKey
  curve: CurveState
}

export interface LandedTx {
  signature: string
  kind: 'buy' | 'sell' | 'close'
  programs: string[]
  tipLamports: bigint
  tipAccount?: string
  closesAccount: boolean
  computeUnitLimit?: number
  receivedBy: string[]
}

function ed25519Verify(pubkey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pubkey)])
  return verify(null, message, createPublicKey({ key: spki, format: 'der', type: 'spki' }), signature)
}

/**
 * In-process stand-in for a Solana RPC node, its websocket log stream and a
 * Jito block engine. Transactions are signature-checked, decoded and executed
 * against bonding-curve math, and their pump events are streamed back exactly
 * as the real program logs them.
 */
export class MockChain {
  readonly tipAccounts = [key(), key(), key()]
  slot = 1_000
  blockHeight = 900
  private server!: Server
  private wss!: WebSocketServer
  private subs = new Map<WebSocket, number>()
  readonly coins = new Map<string, CoinState>()
  private readonly lamports = new Map<string, bigint>()
  private readonly tokens = new Map<string, bigint>()
  private readonly statuses = new Map<string, { slot: number; err: unknown }>()
  private readonly deltas = new Map<string, { payer: string; pre: bigint; post: bigint; fee: bigint }>()
  readonly landed: LandedTx[] = []
  private readonly seen = new Map<string, LandedTx>()
  /** Makes the next N buy transactions fail on-chain with a slippage error. */
  failNextBuys = 0
  /** Makes the next N sell transactions fail on-chain with a slippage error. */
  failNextSells = 0
  /** Accepts the next N transactions but holds them, unexecuted, until `release()` (in flight). */
  holdNext = 0
  private held: { signature: string; base64: string; via: string }[] = []
  /** RPC methods that fail for now (an outage). */
  readonly failing = new Set<string>()

  async start(): Promise<number> {
    this.server = createServer((req, res) => {
      void this.readJson(req).then((body) => {
        const reply = (result: unknown) => res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
        const fail = (message: string) => res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32002, message } }))
        try {
          const via = req.url?.startsWith('/api/v1') ? 'jito' : 'rpc'
          reply(this.rpc(body.method, body.params ?? [], via))
        } catch (e) {
          fail((e as Error).message)
        }
      })
    })
    this.wss = new WebSocketServer({ server: this.server })
    this.wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString())
        if (msg.method === 'logsSubscribe') {
          const id = 7_000 + this.subs.size
          this.subs.set(ws, id)
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: id }))
        }
      })
    })
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r))
    return (this.server.address() as AddressInfo).port
  }

  async stop(): Promise<void> {
    for (const ws of this.wss.clients) ws.terminate()
    await new Promise<void>((r) => this.server.close(() => r()))
  }

  /** The held transactions land now. */
  release(): void {
    for (const h of this.held.splice(0)) this.execute(h.base64, h.via, true)
  }

  /** The held transactions never land: they are dropped and their blockhash expires. */
  dropHeld(): void {
    this.held.splice(0)
    this.blockHeight += 200
  }

  tokensOf(mint: PublicKey, owner: PublicKey): bigint {
    return this.tokenBalance(mint, owner)
  }

  /** Tokens leave `owner`'s wallet without a transaction the bot sent (sold elsewhere). */
  drain(mint: PublicKey, owner: PublicKey, tokens: bigint): void {
    const coin = this.coins.get(mint.toBase58())!
    this.emitLogs(this.fakeSig(), [this.sell(coin, owner, tokens).line])
  }

  fund(owner: PublicKey, lamports: bigint): void {
    this.lamports.set(owner.toBase58(), lamports)
  }

  balanceOf(owner: PublicKey): bigint {
    return this.lamports.get(owner.toBase58()) ?? 0n
  }

  // Chain actions --------------------------------------------------------------

  /** A new coin: create_v2 plus the dev's buy in one transaction, like pump.fun does. */
  launch(opts: { name?: string; symbol?: string; devBuyLamports?: bigint; dev?: PublicKey } = {}): { mint: PublicKey; dev: PublicKey } {
    const mint = key()
    const dev = opts.dev ?? key()
    const creator = dev
    const curve: CurveState = {
      virtualTokenReserves: 1_073_000_000_000_000n,
      virtualQuoteReserves: 30_000_000_000n,
      realTokenReserves: 793_100_000_000_000n,
      realQuoteReserves: 0n,
      tokenTotalSupply: 1_000_000_000_000_000n,
      complete: false,
      creator,
      isMayhemMode: false,
      creatorFeeBps: 0n,
    }
    const coin: CoinState = { mint, creator, curve }
    this.coins.set(mint.toBase58(), coin)
    const create = this.event('CreateEvent', EVENT.create, {
      name: opts.name ?? 'Test Coin',
      symbol: opts.symbol ?? 'TEST',
      uri: 'https://ipfs.io/ipfs/QmTest',
      mint,
      bonding_curve: bondingCurvePda(mint),
      user: dev,
      creator,
      timestamp: bn(Math.floor(Date.now() / 1000)),
      virtual_token_reserves: bn(curve.virtualTokenReserves),
      virtual_sol_reserves: bn(curve.virtualQuoteReserves),
      real_token_reserves: bn(curve.realTokenReserves),
      token_total_supply: bn(curve.tokenTotalSupply),
      token_program: TOKEN_2022_PROGRAM_ID,
      is_mayhem_mode: false,
      is_cashback_enabled: false,
      quote_mint: PublicKey.default,
      virtual_quote_reserves: bn(curve.virtualQuoteReserves),
      creator_fee_bps: bn(0),
      is_holder_reward: false,
    })
    const lines = [create]
    if (opts.devBuyLamports) lines.push(this.buy(coin, dev, opts.devBuyLamports).line)
    this.emitLogs(this.fakeSig(), lines)
    return { mint, dev }
  }

  /** Another wallet trades the coin. */
  trade(mint: PublicKey, opts: { user?: PublicKey; buyLamports?: bigint; sellTokens?: bigint }): void {
    const coin = this.coins.get(mint.toBase58())!
    const user = opts.user ?? key()
    const line = opts.buyLamports !== undefined ? this.buy(coin, user, opts.buyLamports).line : this.sell(coin, user, opts.sellTokens!).line
    this.emitLogs(this.fakeSig(), [line])
  }

  // Internals ------------------------------------------------------------------

  private buy(coin: CoinState, user: PublicKey, spendable: bigint) {
    const q = quoteBuyExactIn(coin.curve, RATES, spendable)
    const intoCurve = buyCostForTokens(coin.curve, q.tokensOut)
    coin.curve = {
      ...coin.curve,
      virtualTokenReserves: coin.curve.virtualTokenReserves - q.tokensOut,
      virtualQuoteReserves: coin.curve.virtualQuoteReserves + intoCurve,
      realTokenReserves: coin.curve.realTokenReserves - q.tokensOut,
      realQuoteReserves: coin.curve.realQuoteReserves + intoCurve,
    }
    const fee = ceilDiv(intoCurve * PROTOCOL_BPS, 10_000n)
    const creatorFee = ceilDiv(intoCurve * CREATOR_BPS, 10_000n)
    this.addTokens(coin.mint, user, q.tokensOut)
    return { tokens: q.tokensOut, paid: intoCurve + fee + creatorFee, line: this.tradeLine(coin, user, true, intoCurve, q.tokensOut, fee, creatorFee) }
  }

  private sell(coin: CoinState, user: PublicKey, tokens: bigint) {
    const q = quoteSell(coin.curve, RATES, tokens)
    coin.curve = applySell(coin.curve, tokens, q.grossQuote)
    const fee = ceilDiv(q.grossQuote * PROTOCOL_BPS, 10_000n)
    const creatorFee = ceilDiv(q.grossQuote * CREATOR_BPS, 10_000n)
    this.addTokens(coin.mint, user, -tokens)
    return { received: q.grossQuote - fee - creatorFee, line: this.tradeLine(coin, user, false, q.grossQuote, tokens, fee, creatorFee) }
  }

  private tradeLine(coin: CoinState, user: PublicKey, isBuy: boolean, sol: bigint, tokens: bigint, fee: bigint, creatorFee: bigint): string {
    return this.event('TradeEvent', EVENT.trade, {
      mint: coin.mint, sol_amount: bn(sol), token_amount: bn(tokens), is_buy: isBuy, user,
      timestamp: bn(Math.floor(Date.now() / 1000)),
      virtual_sol_reserves: bn(coin.curve.virtualQuoteReserves), virtual_token_reserves: bn(coin.curve.virtualTokenReserves),
      real_sol_reserves: bn(coin.curve.realQuoteReserves), real_token_reserves: bn(coin.curve.realTokenReserves),
      fee_recipient: key(), fee_basis_points: bn(PROTOCOL_BPS), fee: bn(fee),
      creator: coin.creator, creator_fee_basis_points: bn(CREATOR_BPS), creator_fee: bn(creatorFee),
      track_volume: true, total_unclaimed_tokens: bn(0), total_claimed_tokens: bn(0), current_sol_volume: bn(0),
      last_update_timestamp: bn(0), ix_name: isBuy ? 'buy_exact_quote_in_v2' : 'sell_v2', mayhem_mode: false,
      cashback_fee_basis_points: bn(0), cashback: bn(0), buyback_fee_basis_points: bn(0), buyback_fee: bn(0),
      shareholders: [], quote_mint: NATIVE_MINT, quote_amount: bn(sol),
      virtual_quote_reserves: bn(coin.curve.virtualQuoteReserves), real_quote_reserves: bn(coin.curve.realQuoteReserves),
      holder_rewards_bps: bn(0), holder_rewards: bn(0),
    })
  }

  private event(name: string, disc: Uint8Array, fields: Record<string, unknown>): string {
    return `Program data: ${Buffer.concat([Buffer.from(disc), pumpCoder.types.encode(name, fields)]).toString('base64')}`
  }

  private emitLogs(signature: string, dataLines: string[], err: unknown = null): void {
    this.slot++
    this.blockHeight++
    const logs = [`Program ${P} invoke [1]`, ...dataLines, `Program ${P} success`]
    for (const [ws, sub] of this.subs) {
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        method: 'logsNotification',
        params: { subscription: sub, result: { context: { slot: this.slot }, value: { signature, err, logs } } },
      }))
    }
  }

  private fakeSig(): string {
    return bs58.encode(Keypair.generate().secretKey)
  }

  private addTokens(mint: PublicKey, owner: PublicKey, delta: bigint): void {
    const k = `${mint.toBase58()}:${owner.toBase58()}`
    this.tokens.set(k, (this.tokens.get(k) ?? 0n) + delta)
  }

  private tokenBalance(mint: PublicKey, owner: PublicKey): bigint {
    return this.tokens.get(`${mint.toBase58()}:${owner.toBase58()}`) ?? 0n
  }

  private readJson(req: IncomingMessage): Promise<{ id: number; method: string; params?: unknown[] }> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')))
    })
  }

  private accountJson(pubkey: string) {
    const b64 = (data: Buffer, owner = P) => ({ data: [data.toString('base64'), 'base64'], owner, lamports: 1, executable: false })
    if (pubkey === GLOBAL_PDA.toBase58()) return b64(this.globalData())
    if (pubkey === FEE_CONFIG_PDA.toBase58()) return b64(this.feeConfigData())
    for (const coin of this.coins.values()) {
      if (pubkey === bondingCurvePda(coin.mint).toBase58()) {
        return b64(encodeAccount(pumpCoder, 'BondingCurve', {
          virtual_token_reserves: bn(coin.curve.virtualTokenReserves), virtual_quote_reserves: bn(coin.curve.virtualQuoteReserves),
          real_token_reserves: bn(coin.curve.realTokenReserves), real_quote_reserves: bn(coin.curve.realQuoteReserves),
          token_total_supply: bn(coin.curve.tokenTotalSupply), complete: coin.curve.complete, creator: coin.creator,
          is_mayhem_mode: false, is_cashback_coin: false, quote_mint: PublicKey.default, creator_fee_bps: bn(0),
          can_edit_creator_fee: false, is_holder_reward: false,
        }))
      }
      if (pubkey === coin.mint.toBase58()) return b64(Buffer.alloc(82), TOKEN_2022_PROGRAM_ID.toBase58())
    }
    return null
  }

  private globalData(): Buffer {
    const keys = (n: number) => Array.from({ length: n }, key)
    return encodeAccount(pumpCoder, 'Global', {
      initialized: true, authority: key(), fee_recipient: key(),
      initial_virtual_token_reserves: bn(1_073_000_000_000_000n), initial_virtual_sol_reserves: bn(30_000_000_000n),
      initial_real_token_reserves: bn(793_100_000_000_000n), token_total_supply: bn(1_000_000_000_000_000n),
      fee_basis_points: bn(PROTOCOL_BPS), withdraw_authority: key(), enable_migrate: false, pool_migration_fee: bn(0),
      creator_fee_basis_points: bn(CREATOR_BPS), fee_recipients: keys(7), set_creator_authority: key(),
      admin_set_creator_authority: key(), create_v2_enabled: true, whitelist_pda: key(), reserved_fee_recipient: key(),
      mayhem_mode_enabled: false, reserved_fee_recipients: keys(7), is_cashback_enabled: false,
      buyback_fee_recipients: keys(8), buyback_basis_points: bn(0), initial_virtual_quote_reserves: bn(0),
      whitelisted_quote_mints: keys(1), creator_fee_configurable: false, max_configurable_creator_fee_bps: bn(0),
      holder_reward_claim_authority: key(), is_holder_reward_enabled: false,
    })
  }

  private feeConfigData(): Buffer {
    const fees = { lp_fee_bps: bn(0), protocol_fee_bps: bn(PROTOCOL_BPS), creator_fee_bps: bn(CREATOR_BPS) }
    return encodeAccount(feesCoder, 'FeeConfig', {
      bump: 255, admin: key(), flat_fees: fees,
      fee_tiers: [{ market_cap_lamports_threshold: bn(0), fees }],
      stable_fee_tiers: [], exotic_flat_fees: fees,
    }, 2512)
  }

  private rpc(method: string, params: unknown[], via: string): unknown {
    const ctx = { context: { slot: this.slot } }
    if (this.failing.has(method)) throw new Error('mock outage')
    switch (method) {
      case 'getLatestBlockhash':
        return { ...ctx, value: { blockhash: bs58.encode(Buffer.alloc(32, 7)), lastValidBlockHeight: this.blockHeight + 150 } }
      case 'getSlot':
        return this.slot
      case 'getBlockHeight':
        return this.blockHeight
      case 'getHealth':
        return 'ok'
      case 'getTipAccounts':
        return this.tipAccounts.map((k) => k.toBase58())
      case 'getRecentPrioritizationFees':
        return []
      case 'getBalance':
        return { ...ctx, value: Number(this.lamports.get(params[0] as string) ?? 0n) }
      case 'getAccountInfo':
        return { ...ctx, value: this.accountJson(params[0] as string) }
      case 'getMultipleAccounts':
        return { ...ctx, value: (params[0] as string[]).map((k) => this.accountJson(k)) }
      case 'getTokenAccountBalance': {
        for (const coin of this.coins.values()) {
          for (const [k, amount] of this.tokens) {
            const [m, owner] = k.split(':')
            if (m === coin.mint.toBase58() && associatedTokenAddress(new PublicKey(owner!), coin.mint, TOKEN_2022_PROGRAM_ID).toBase58() === params[0]) {
              return { ...ctx, value: { amount: amount.toString(), decimals: 6 } }
            }
          }
        }
        throw new Error('could not find account')
      }
      case 'getSignatureStatuses':
        return {
          ...ctx,
          value: (params[0] as string[]).map((s) => {
            const st = this.statuses.get(s)
            return st ? { slot: st.slot, confirmations: 1, err: st.err, confirmationStatus: 'confirmed' } : null
          }),
        }
      case 'getTransaction': {
        const d = this.deltas.get(params[0] as string)
        if (!d) return null
        return {
          slot: this.slot,
          meta: { fee: Number(d.fee), preBalances: [Number(d.pre)], postBalances: [Number(d.post)] },
          transaction: { message: { accountKeys: [{ pubkey: d.payer }] } },
        }
      }
      case 'sendTransaction':
        return this.execute(params[0] as string, via)
    }
    throw new Error(`mock: unsupported method ${method}`)
  }

  /** Verifies, decodes and executes a submitted transaction. */
  private execute(base64: string, via: string, released = false): string {
    const tx = VersionedTransaction.deserialize(Buffer.from(base64, 'base64'))
    const signature = bs58.encode(tx.signatures[0]!)
    const already = this.seen.get(signature)
    if (already) {
      already.receivedBy.push(via)
      return signature
    }
    // Held (or re-broadcast while held): accepted, not executed.
    if (!released && this.held.some((h) => h.signature === signature)) return signature
    if (!released && this.holdNext > 0) {
      this.holdNext--
      this.held.push({ signature, base64, via })
      return signature
    }
    const keys = tx.message.staticAccountKeys
    const payer = keys[0]!
    if (!ed25519Verify(payer.toBytes(), tx.message.serialize(), tx.signatures[0]!)) throw new Error('signature verification failed')

    const record: LandedTx = { signature, kind: 'buy', programs: [], tipLamports: 0n, closesAccount: false, receivedBy: [via] }
    this.seen.set(signature, record)
    let pumpIx: { data: Uint8Array; accounts: PublicKey[] } | undefined
    for (const ix of tx.message.compiledInstructions) {
      const program = keys[ix.programIdIndex]!
      record.programs.push(program.toBase58())
      const accounts = ix.accountKeyIndexes.map((i) => keys[i]!)
      if (program.equals(PUMP_PROGRAM_ID)) pumpIx = { data: ix.data, accounts }
      if (program.equals(COMPUTE_BUDGET_PROGRAM_ID) && ix.data[0] === 2) record.computeUnitLimit = Buffer.from(ix.data).readUInt32LE(1)
      if (program.equals(SystemProgram.programId) && ix.data[0] === 2) {
        record.tipLamports = Buffer.from(ix.data).readBigUInt64LE(4)
        record.tipAccount = accounts[1]!.toBase58()
      }
      if (program.equals(TOKEN_2022_PROGRAM_ID) && ix.data[0] === 9) record.closesAccount = true
    }
    if (!pumpIx && record.closesAccount) return this.closeOnly(tx, record, signature)
    if (!pumpIx) throw new Error('no pump instruction')

    const data = Buffer.from(pumpIx.data)
    const mint = pumpIx.accounts[1]!
    const user = pumpIx.accounts[13]!
    if (!user.equals(payer)) throw new Error('pump user is not the fee payer')
    const coin = this.coins.get(mint.toBase58())
    if (!coin) throw new Error('unknown mint')
    const creatorVault = pumpIx.accounts[16]!
    const expectedVault = PublicKey.findProgramAddressSync([Buffer.from('creator-vault'), coin.creator.toBytes()], PUMP_PROGRAM_ID)[0]
    if (!creatorVault.equals(expectedVault)) throw new Error('wrong creator vault')

    const pre = this.balanceOf(payer)
    const txFee = 5_000n
    let line: string
    let err: unknown = null
    let post = pre - txFee
    if (discriminatorEquals(data, IX.buyExactQuoteInV2)) {
      const spendable = data.readBigUInt64LE(8)
      const minOut = data.readBigUInt64LE(16)
      const quote = quoteBuyExactIn(coin.curve, RATES, spendable)
      if (this.failNextBuys > 0 || quote.tokensOut < minOut) {
        this.failNextBuys = Math.max(0, this.failNextBuys - 1)
        err = { InstructionError: [3, { Custom: 6042 }] }
        line = ''
      } else {
        const r = this.buy(coin, payer, spendable)
        post -= r.paid + record.tipLamports + 2_039_280n // ATA rent
        line = r.line
      }
    } else if (discriminatorEquals(data, IX.sellV2)) {
      record.kind = 'sell'
      const amount = data.readBigUInt64LE(8)
      const minOut = data.readBigUInt64LE(16)
      if (this.tokenBalance(mint, payer) < amount) {
        err = { InstructionError: [2, { Custom: 6023 }] }
        line = ''
      } else {
        const q = quoteSell(coin.curve, RATES, amount)
        if (this.failNextSells > 0 || q.quoteOut < minOut) {
          this.failNextSells = Math.max(0, this.failNextSells - 1)
          err = { InstructionError: [2, { Custom: 6003 }] }
          line = ''
        } else {
          const r = this.sell(coin, payer, amount)
          post += r.received - record.tipLamports + (record.closesAccount ? 2_039_280n : 0n)
          if (record.closesAccount) this.tokens.delete(`${mint.toBase58()}:${payer.toBase58()}`)
          line = r.line
        }
      }
    } else {
      throw new Error('unsupported pump instruction')
    }

    this.lamports.set(payer.toBase58(), post)
    this.deltas.set(signature, { payer: payer.toBase58(), pre, post, fee: txFee })
    this.landed.push(record)
    setTimeout(() => {
      this.statuses.set(signature, { slot: this.slot + 1, err })
      this.emitLogs(signature, line ? [line] : [], err)
    }, 25)
    return signature
  }

  /** Closing an empty token account on its own: its rent comes back. */
  private closeOnly(tx: VersionedTransaction, record: LandedTx, signature: string): string {
    record.kind = 'close'
    const keys = tx.message.staticAccountKeys
    const payer = keys[0]!
    const closeIx = tx.message.compiledInstructions.find((ix) => keys[ix.programIdIndex]!.equals(TOKEN_2022_PROGRAM_ID))!
    const ata = keys[closeIx.accountKeyIndexes[0]!]!.toBase58()
    const entry = [...this.tokens].find(([k]) => {
      const [m, owner] = k.split(':')
      return associatedTokenAddress(new PublicKey(owner!), new PublicKey(m!), TOKEN_2022_PROGRAM_ID).toBase58() === ata
    })
    const pre = this.balanceOf(payer)
    let post = pre - 5_000n
    let err: unknown = null
    if (!entry || entry[1] !== 0n) err = { InstructionError: [2, { Custom: 11 }] }
    else {
      this.tokens.delete(entry[0])
      post += 2_039_280n
    }
    this.lamports.set(payer.toBase58(), post)
    this.deltas.set(signature, { payer: payer.toBase58(), pre, post, fee: 5_000n })
    this.landed.push(record)
    setTimeout(() => {
      this.statuses.set(signature, { slot: this.slot + 1, err })
      this.emitLogs(signature, [], err)
    }, 25)
    return signature
  }
}
