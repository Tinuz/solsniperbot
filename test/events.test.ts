import { Keypair, PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import {
  ANCHOR_EVENT_IX_TAG,
  EVENT,
  NATIVE_MINT,
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '../src/pump/constants.js'
import {
  type CreateEvent,
  type TradeEvent,
  decodeCpiEventInstruction,
  decodePumpEvent,
  decodePumpInstruction,
  parsePumpLogs,
} from '../src/pump/events.js'
import { bn, pumpCoder } from './helpers.js'

const key = () => Keypair.generate().publicKey

function encodeEvent(name: string, disc: Uint8Array, fields: Record<string, unknown>): Buffer {
  return Buffer.concat([Buffer.from(disc), pumpCoder.types.encode(name, fields)])
}

const createFields = (mint: PublicKey, creator: PublicKey) => ({
  name: 'Doge Moon 🚀',
  symbol: 'DMOON',
  uri: 'https://ipfs.io/ipfs/QmExample',
  mint,
  bonding_curve: key(),
  user: key(),
  creator,
  timestamp: bn(1_758_000_000),
  virtual_token_reserves: bn(1_073_000_000_000_000n),
  virtual_sol_reserves: bn(30_000_000_000n),
  real_token_reserves: bn(793_100_000_000_000n),
  token_total_supply: bn(1_000_000_000_000_000n),
  token_program: TOKEN_2022_PROGRAM_ID,
  is_mayhem_mode: false,
  is_cashback_enabled: false,
  quote_mint: PublicKey.default,
  virtual_quote_reserves: bn(30_000_000_000n),
  creator_fee_bps: bn(0),
  is_holder_reward: true,
})

const tradeFields = (mint: PublicKey, user: PublicKey) => ({
  mint,
  sol_amount: bn(1_500_000_000n),
  token_amount: bn(51_000_000_000_000n),
  is_buy: true,
  user,
  timestamp: bn(1_758_000_001),
  virtual_sol_reserves: bn(31_500_000_000n),
  virtual_token_reserves: bn(1_022_000_000_000_000n),
  real_sol_reserves: bn(1_500_000_000n),
  real_token_reserves: bn(742_100_000_000_000n),
  fee_recipient: key(),
  fee_basis_points: bn(95),
  fee: bn(14_250_000n),
  creator: key(),
  creator_fee_basis_points: bn(30),
  creator_fee: bn(4_500_000n),
  track_volume: true,
  total_unclaimed_tokens: bn(0),
  total_claimed_tokens: bn(0),
  current_sol_volume: bn(0),
  last_update_timestamp: bn(0),
  ix_name: 'buy_exact_quote_in_v2',
  mayhem_mode: false,
  cashback_fee_basis_points: bn(0),
  cashback: bn(0),
  buyback_fee_basis_points: bn(5),
  buyback_fee: bn(750_000n),
  shareholders: [
    { address: key(), share_bps: 6000 },
    { address: key(), share_bps: 4000 },
  ],
  quote_mint: NATIVE_MINT,
  quote_amount: bn(1_500_000_000n),
  virtual_quote_reserves: bn(31_500_000_000n),
  real_quote_reserves: bn(1_500_000_000n),
  holder_rewards_bps: bn(30),
  holder_rewards: bn(4_500_000n),
})

const P = PUMP_PROGRAM_ID.toBase58()
const dataLine = (buf: Buffer) => `Program data: ${buf.toString('base64')}`

describe('event decoding', () => {
  it('decodes a CreateEvent identically to the IDL coder', () => {
    const mint = key()
    const creator = key()
    const ev = decodePumpEvent(encodeEvent('CreateEvent', EVENT.create, createFields(mint, creator))) as CreateEvent
    expect(ev.kind).toBe('create')
    expect(ev.name).toBe('Doge Moon 🚀')
    expect(ev.symbol).toBe('DMOON')
    expect(ev.mint.equals(mint)).toBe(true)
    expect(ev.creator.equals(creator)).toBe(true)
    expect(ev.virtualTokenReserves).toBe(1_073_000_000_000_000n)
    expect(ev.virtualSolReserves).toBe(30_000_000_000n)
    expect(ev.realTokenReserves).toBe(793_100_000_000_000n)
    expect(ev.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)).toBe(true)
    expect(ev.isHolderReward).toBe(true)
    expect(ev.timestamp).toBe(1_758_000_000)
  })

  it('decodes a TradeEvent including fields after the shareholders vec', () => {
    const mint = key()
    const user = key()
    const ev = decodePumpEvent(encodeEvent('TradeEvent', EVENT.trade, tradeFields(mint, user))) as TradeEvent
    expect(ev.kind).toBe('trade')
    expect(ev.mint.equals(mint)).toBe(true)
    expect(ev.user.equals(user)).toBe(true)
    expect(ev.isBuy).toBe(true)
    expect(ev.solAmount).toBe(1_500_000_000n)
    expect(ev.tokenAmount).toBe(51_000_000_000_000n)
    expect(ev.virtualTokenReserves).toBe(1_022_000_000_000_000n)
    expect(ev.fee).toBe(14_250_000n)
    expect(ev.creatorFee).toBe(4_500_000n)
    expect(ev.ixName).toBe('buy_exact_quote_in_v2')
    expect(ev.buybackFee).toBe(750_000n)
    // These come after the variable-length shareholders vec.
    expect(ev.quoteMint.equals(NATIVE_MINT)).toBe(true)
    expect(ev.virtualQuoteReserves).toBe(31_500_000_000n)
    expect(ev.realQuoteReserves).toBe(1_500_000_000n)
  })

  it('reads older, shorter CreateEvents with legacy defaults', () => {
    const full = encodeEvent('CreateEvent', EVENT.create, createFields(key(), key()))
    const nameLen = 4 + Buffer.byteLength('Doge Moon 🚀')
    const upToSupply = 8 + nameLen + (4 + 5) + (4 + 30) + 32 * 4 + 8 + 8 * 4
    const ev = decodePumpEvent(full.subarray(0, upToSupply)) as CreateEvent
    expect(ev.tokenProgram.equals(TOKEN_PROGRAM_ID)).toBe(true)
    expect(ev.isHolderReward).toBe(false)
    expect(ev.tokenTotalSupply).toBe(1_000_000_000_000_000n)
  })

  it('ignores unknown payloads', () => {
    expect(decodePumpEvent(Buffer.alloc(40, 7))).toBeNull()
    expect(decodePumpEvent(Buffer.alloc(3))).toBeNull()
  })

  it('decodes emit_cpi self-invocation data', () => {
    const payload = encodeEvent('TradeEvent', EVENT.trade, tradeFields(key(), key()))
    const ev = decodeCpiEventInstruction(Buffer.concat([Buffer.from(ANCHOR_EVENT_IX_TAG), payload]))
    expect(ev?.kind).toBe('trade')
    expect(decodeCpiEventInstruction(payload)).toBeNull()
  })
})

describe('parsePumpLogs', () => {
  it('extracts create + dev buy from a create transaction', () => {
    const mint = key()
    const logs = [
      'Program ComputeBudget111111111111111111111111111111 invoke [1]',
      'Program ComputeBudget111111111111111111111111111111 success',
      `Program ${P} invoke [1]`,
      'Program log: Instruction: CreateV2',
      `Program ${TOKEN_2022_PROGRAM_ID.toBase58()} invoke [2]`,
      'Program log: Instruction: InitializeMint2',
      `Program ${TOKEN_2022_PROGRAM_ID.toBase58()} consumed 1000 of 180000 compute units`,
      `Program ${TOKEN_2022_PROGRAM_ID.toBase58()} success`,
      dataLine(encodeEvent('CreateEvent', EVENT.create, createFields(mint, key()))),
      `Program ${P} invoke [2]`,
      `Program ${P} consumed 2000 of 150000 compute units`,
      `Program ${P} success`,
      `Program ${P} consumed 90000 of 190000 compute units`,
      `Program ${P} success`,
      `Program ${P} invoke [1]`,
      'Program log: Instruction: BuyExactQuoteInV2',
      dataLine(encodeEvent('TradeEvent', EVENT.trade, tradeFields(mint, key()))),
      `Program ${P} success`,
    ]
    const events = parsePumpLogs(logs)
    expect(events.map((e) => e.kind)).toEqual(['create', 'trade'])
    expect((events[0] as CreateEvent).mint.equals(mint)).toBe(true)
  })

  it('ignores data lines emitted by other programs', () => {
    const logs = [
      `Program ${PUMP_AMM_PROGRAM_ID.toBase58()} invoke [1]`,
      dataLine(encodeEvent('TradeEvent', EVENT.trade, tradeFields(key(), key()))),
      `Program ${PUMP_AMM_PROGRAM_ID.toBase58()} success`,
    ]
    expect(parsePumpLogs(logs)).toEqual([])
  })

  it('keeps attribution through failed inner calls and stops at truncation', () => {
    const trade = dataLine(encodeEvent('TradeEvent', EVENT.trade, tradeFields(key(), key())))
    const logs = [
      `Program ${P} invoke [1]`,
      'Program log: something invoke [9]',
      `Program ${TOKEN_PROGRAM_ID.toBase58()} invoke [2]`,
      `Program ${TOKEN_PROGRAM_ID.toBase58()} failed: custom program error: 0x1`,
      trade,
      'Log truncated',
      trade,
    ]
    expect(parsePumpLogs(logs)).toHaveLength(1)
  })
})

describe('instruction decoding (shred-level detection)', () => {
  it('decodes create_v2 args and account positions', () => {
    const creator = key()
    const data = pumpCoder.instruction.encode('create_v2', {
      name: 'Cat',
      symbol: 'CAT',
      uri: 'ipfs://x',
      creator,
      is_mayhem_mode: true,
      is_cashback_enabled: [false],
      creator_fee_bps: [bn(0)],
      is_holder_reward: [true],
    })
    const accounts = Array.from({ length: 16 }, () => key())
    const ix = decodePumpInstruction(data, accounts)
    expect(ix).toMatchObject({ kind: 'create', version: 2, name: 'Cat', symbol: 'CAT', uri: 'ipfs://x', isMayhemMode: true, isHolderReward: true })
    if (ix?.kind !== 'create') throw new Error('expected create')
    expect(ix.mint.equals(accounts[0]!)).toBe(true)
    expect(ix.user.equals(accounts[5]!)).toBe(true)
    expect(ix.tokenProgram.equals(accounts[7]!)).toBe(true)
    expect(ix.creator.equals(creator)).toBe(true)
    expect(ix.quoteMint.equals(PublicKey.default)).toBe(true)
  })

  it('decodes create_v2 without trailing optional args', () => {
    const data = pumpCoder.instruction.encode('create_v2', {
      name: 'A', symbol: 'B', uri: 'C', creator: key(), is_mayhem_mode: false,
      is_cashback_enabled: [false], creator_fee_bps: [bn(0)], is_holder_reward: [false],
    })
    const trimmed = data.subarray(0, data.length - 1 - 8 - 1)
    const ix = decodePumpInstruction(trimmed, Array.from({ length: 16 }, () => key()))
    expect(ix).toMatchObject({ kind: 'create', isHolderReward: false, isMayhemMode: false })
  })

  it('decodes each buy flavour with the right mint/user positions', () => {
    const accounts = Array.from({ length: 27 }, () => key())
    const v2 = decodePumpInstruction(pumpCoder.instruction.encode('buy_v2', { amount: bn(10), max_sol_cost: bn(20) }), accounts)
    expect(v2).toMatchObject({ kind: 'buy', tokenAmount: 10n, maxQuoteCost: 20n })
    expect(v2?.kind === 'buy' && v2.mint.equals(accounts[1]!) && v2.user.equals(accounts[13]!)).toBe(true)

    const exact = decodePumpInstruction(
      pumpCoder.instruction.encode('buy_exact_sol_in', { spendable_sol_in: bn(30), min_tokens_out: bn(40), track_volume: [true] }),
      accounts,
    )
    expect(exact).toMatchObject({ kind: 'buy', spendableQuote: 30n, minTokensOut: 40n })
    expect(exact?.kind === 'buy' && exact.mint.equals(accounts[2]!) && exact.user.equals(accounts[6]!)).toBe(true)

    expect(decodePumpInstruction(pumpCoder.instruction.encode('sell_v2', { amount: bn(1), min_sol_output: bn(1) }), accounts)).toBeNull()
  })
})
