import { PublicKey } from '@solana/web3.js'
import { BorshReader, discriminatorEquals } from '../util/borsh.js'
import {
  ANCHOR_EVENT_IX_TAG,
  EVENT,
  IX,
  NATIVE_MINT,
  PUMP_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from './constants.js'

export interface CreateEvent {
  kind: 'create'
  name: string
  symbol: string
  uri: string
  mint: PublicKey
  bondingCurve: PublicKey
  /** Fee payer of the create transaction. */
  user: PublicKey
  creator: PublicKey
  timestamp: number
  virtualTokenReserves: bigint
  virtualSolReserves: bigint
  realTokenReserves: bigint
  tokenTotalSupply: bigint
  tokenProgram: PublicKey
  isMayhemMode: boolean
  isCashbackEnabled: boolean
  /** `PublicKey.default` or wrapped SOL for SOL-paired coins. */
  quoteMint: PublicKey
  virtualQuoteReserves: bigint
  creatorFeeBps: bigint
  isHolderReward: boolean
}

export interface TradeEvent {
  kind: 'trade'
  mint: PublicKey
  /** Quote paid into (buy) or out of (sell) the curve, excluding fees. */
  solAmount: bigint
  tokenAmount: bigint
  isBuy: boolean
  user: PublicKey
  timestamp: number
  virtualSolReserves: bigint
  virtualTokenReserves: bigint
  realSolReserves: bigint
  realTokenReserves: bigint
  feeRecipient: PublicKey
  fee: bigint
  creator: PublicKey
  creatorFee: bigint
  ixName: string
  mayhemMode: boolean
  cashback: bigint
  buybackFee: bigint
  quoteMint: PublicKey
  quoteAmount: bigint
  virtualQuoteReserves: bigint
  realQuoteReserves: bigint
}

export interface CompleteEvent {
  kind: 'complete'
  user: PublicKey
  mint: PublicKey
  bondingCurve: PublicKey
  timestamp: number
}

export interface MigrationEvent {
  kind: 'migration'
  user: PublicKey
  mint: PublicKey
  bondingCurve: PublicKey
  pool: PublicKey
  timestamp: number
}

export type PumpEvent = CreateEvent | TradeEvent | CompleteEvent | MigrationEvent

// Event decoding ---------------------------------------------------------------

function decodeCreate(r: BorshReader): CreateEvent {
  return {
    kind: 'create',
    name: r.string(),
    symbol: r.string(),
    uri: r.string(),
    mint: r.pubkey(),
    bondingCurve: r.pubkey(),
    user: r.pubkey(),
    creator: r.pubkey(),
    timestamp: Number(r.i64()),
    virtualTokenReserves: r.u64(),
    virtualSolReserves: r.u64(),
    realTokenReserves: r.u64(),
    tokenTotalSupply: r.u64(),
    // Events from before Token-2022 launches end here; they used the legacy program.
    tokenProgram: r.exhausted ? TOKEN_PROGRAM_ID : r.pubkey(),
    isMayhemMode: r.bool(),
    isCashbackEnabled: r.bool(),
    quoteMint: r.pubkey(),
    virtualQuoteReserves: r.u64(),
    creatorFeeBps: r.u64(),
    isHolderReward: r.bool(),
  }
}

function decodeTrade(r: BorshReader): TradeEvent {
  const mint = r.pubkey()
  const solAmount = r.u64()
  const tokenAmount = r.u64()
  const isBuy = r.bool()
  const user = r.pubkey()
  const timestamp = Number(r.i64())
  const virtualSolReserves = r.u64()
  const virtualTokenReserves = r.u64()
  const realSolReserves = r.u64()
  const realTokenReserves = r.u64()
  const feeRecipient = r.pubkey()
  r.u64() // fee_basis_points
  const fee = r.u64()
  const creator = r.pubkey()
  r.u64() // creator_fee_basis_points
  const creatorFee = r.u64()
  r.bool() // track_volume
  r.u64() // total_unclaimed_tokens
  r.u64() // total_claimed_tokens
  r.u64() // current_sol_volume
  r.i64() // last_update_timestamp
  const ixName = r.string()
  const mayhemMode = r.bool()
  r.u64() // cashback_fee_basis_points
  const cashback = r.u64()
  r.u64() // buyback_fee_basis_points
  const buybackFee = r.u64()
  r.vec((s) => s.skip(34), 64) // shareholders: { address: Pubkey, share_bps: u16 }
  const quoteMint = r.pubkey()
  const quoteAmount = r.u64()
  const virtualQuoteReserves = r.u64()
  const realQuoteReserves = r.u64()
  return {
    kind: 'trade',
    mint,
    solAmount,
    tokenAmount,
    isBuy,
    user,
    timestamp,
    virtualSolReserves,
    virtualTokenReserves,
    realSolReserves,
    realTokenReserves,
    feeRecipient,
    fee,
    creator,
    creatorFee,
    ixName,
    mayhemMode,
    cashback,
    buybackFee,
    quoteMint,
    quoteAmount,
    virtualQuoteReserves,
    realQuoteReserves,
  }
}

function decodeComplete(r: BorshReader): CompleteEvent {
  return {
    kind: 'complete',
    user: r.pubkey(),
    mint: r.pubkey(),
    bondingCurve: r.pubkey(),
    timestamp: Number(r.i64()),
  }
}

function decodeMigration(r: BorshReader): MigrationEvent {
  const user = r.pubkey()
  const mint = r.pubkey()
  r.u64() // mint_amount
  r.u64() // sol_amount
  r.u64() // pool_migration_fee
  const bondingCurve = r.pubkey()
  const timestamp = Number(r.i64())
  const pool = r.pubkey()
  return { kind: 'migration', user, mint, bondingCurve, pool, timestamp }
}

/** Decodes one Anchor event payload (`discriminator || borsh`). Unknown events return null. */
export function decodePumpEvent(data: Uint8Array): PumpEvent | null {
  if (data.length < 8) return null
  const r = new BorshReader(data, 8)
  if (discriminatorEquals(data, EVENT.trade)) return decodeTrade(r)
  if (discriminatorEquals(data, EVENT.create)) return decodeCreate(r)
  if (discriminatorEquals(data, EVENT.complete)) return decodeComplete(r)
  if (discriminatorEquals(data, EVENT.completeAmmMigration)) return decodeMigration(r)
  return null
}

/** True when the quote mint denotes SOL (the zero key legacy curves store, or WSOL). */
export function isSolQuote(quoteMint: PublicKey): boolean {
  return quoteMint.equals(PublicKey.default) || quoteMint.equals(NATIVE_MINT)
}

// Log parsing ------------------------------------------------------------------

const PUMP_ID = PUMP_PROGRAM_ID.toBase58()
const DATA_PREFIX = 'Program data: '
const INVOKE_SUFFIX_RE = / invoke \[\d+\]$/

/**
 * Extracts pump events from transaction log messages.
 *
 * Tracks the CPI stack so that `Program data:` lines are only attributed to
 * pump when pump is the currently executing program; other Anchor programs in
 * the same transaction can emit lines with colliding prefixes.
 */
export function parsePumpLogs(logs: readonly string[]): PumpEvent[] {
  const events: PumpEvent[] = []
  const stack: string[] = []
  for (const line of logs) {
    if (line.startsWith(DATA_PREFIX)) {
      if (stack[stack.length - 1] !== PUMP_ID) continue
      const payload = line.slice(DATA_PREFIX.length)
      const space = payload.indexOf(' ')
      const b64 = space === -1 ? payload : payload.slice(0, space)
      const event = decodePumpEvent(Buffer.from(b64, 'base64'))
      if (event) events.push(event)
      continue
    }
    if (!line.startsWith('Program ') || line.startsWith('Program log: ')) {
      if (line === 'Log truncated') break
      continue
    }
    if (INVOKE_SUFFIX_RE.test(line)) {
      stack.push(line.slice(8, line.indexOf(' ', 8)))
    } else if (line.endsWith(' success') || line.includes(' failed')) {
      const id = line.slice(8, line.indexOf(' ', 8))
      if (stack[stack.length - 1] === id) stack.pop()
    }
  }
  return events
}

/** Quick pre-check so non-event notifications skip full parsing. */
export function logsMayContainPumpEvents(logs: readonly string[]): boolean {
  for (const line of logs) if (line.startsWith(DATA_PREFIX)) return true
  return false
}

/** Decodes an `emit_cpi!` self-invocation's instruction data, if it is one. */
export function decodeCpiEventInstruction(data: Uint8Array): PumpEvent | null {
  if (!discriminatorEquals(data, ANCHOR_EVENT_IX_TAG)) return null
  return decodePumpEvent(data.subarray(8))
}

// Instruction decoding (used for shred-level detection, before execution) -----

export interface CreateInstruction {
  kind: 'create'
  version: 1 | 2
  mint: PublicKey
  user: PublicKey
  tokenProgram: PublicKey
  name: string
  symbol: string
  uri: string
  creator: PublicKey
  isMayhemMode: boolean
  isHolderReward: boolean
  quoteMint: PublicKey
}

export interface BuyInstruction {
  kind: 'buy'
  mint: PublicKey
  user: PublicKey
  /** Exact-token buys (`buy`, `buy_v2`). */
  tokenAmount?: bigint
  maxQuoteCost?: bigint
  /** Exact-quote buys (`buy_exact_sol_in`, `buy_exact_quote_in_v2`). */
  spendableQuote?: bigint
  minTokensOut?: bigint
}

export type PumpInstruction = CreateInstruction | BuyInstruction

/**
 * Decodes a pump instruction from raw data and its resolved account list.
 * Returns null for instructions the sniper does not need.
 */
export function decodePumpInstruction(data: Uint8Array, accounts: readonly PublicKey[]): PumpInstruction | null {
  if (data.length < 8) return null
  const r = new BorshReader(data, 8)
  const at = (i: number) => accounts[i] ?? PublicKey.default

  if (discriminatorEquals(data, IX.createV2)) {
    const name = r.string()
    const symbol = r.string()
    const uri = r.string()
    const creator = r.pubkey()
    const isMayhemMode = r.bool()
    r.bool() // is_cashback_enabled (OptionBool)
    r.u64() // creator_fee_bps (OptionU64)
    const isHolderReward = r.bool()
    return {
      kind: 'create',
      version: 2,
      mint: at(0),
      user: at(5),
      tokenProgram: at(7),
      name,
      symbol,
      uri,
      creator,
      isMayhemMode,
      isHolderReward,
      // Optional remaining account #0 selects a non-SOL quote mint.
      quoteMint: accounts.length > 16 ? at(16) : PublicKey.default,
    }
  }
  if (discriminatorEquals(data, IX.create)) {
    return {
      kind: 'create',
      version: 1,
      mint: at(0),
      user: at(7),
      tokenProgram: TOKEN_PROGRAM_ID,
      name: r.string(),
      symbol: r.string(),
      uri: r.string(),
      creator: r.pubkey(),
      isMayhemMode: false,
      isHolderReward: false,
      quoteMint: PublicKey.default,
    }
  }
  if (discriminatorEquals(data, IX.buyV2)) {
    return { kind: 'buy', mint: at(1), user: at(13), tokenAmount: r.u64(), maxQuoteCost: r.u64() }
  }
  if (discriminatorEquals(data, IX.buyExactQuoteInV2)) {
    return { kind: 'buy', mint: at(1), user: at(13), spendableQuote: r.u64(), minTokensOut: r.u64() }
  }
  if (discriminatorEquals(data, IX.buy)) {
    return { kind: 'buy', mint: at(2), user: at(6), tokenAmount: r.u64(), maxQuoteCost: r.u64() }
  }
  if (discriminatorEquals(data, IX.buyExactSolIn)) {
    return { kind: 'buy', mint: at(2), user: at(6), spendableQuote: r.u64(), minTokensOut: r.u64() }
  }
  return null
}
