import { Keypair, PublicKey, type TransactionInstruction } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import {
  FALLBACK_BUYBACK_FEE_RECIPIENTS,
  FALLBACK_FEE_RECIPIENTS,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '../src/pump/constants.js'
import {
  buyExactQuoteInV2Ix,
  buyV2Ix,
  createAtaIdempotentIx,
  sellV2Ix,
  type TradeAccounts,
} from '../src/pump/instructions.js'
import { bn, pumpCoder, sdk } from './helpers.js'

const flatKeys = (ix: TransactionInstruction) =>
  ix.keys.map((k) => `${k.pubkey.toBase58()}:${k.isSigner ? 's' : '-'}${k.isWritable ? 'w' : '-'}`)

function accounts(tokenProgram: PublicKey): TradeAccounts {
  return {
    mint: Keypair.generate().publicKey,
    user: Keypair.generate().publicKey,
    creator: Keypair.generate().publicKey,
    tokenProgram,
    feeRecipient: FALLBACK_FEE_RECIPIENTS[3]!,
    buybackFeeRecipient: FALLBACK_BUYBACK_FEE_RECIPIENTS[5]!,
  }
}

const sdkArgs = (a: TradeAccounts, amount: bigint, quote: bigint) => ({
  user: a.user,
  mint: a.mint,
  creator: a.creator,
  amount: bn(amount),
  quoteAmount: bn(quote),
  feeRecipient: a.feeRecipient,
  buybackFeeRecipient: a.buybackFeeRecipient,
  tokenProgram: a.tokenProgram,
})

describe.each([
  ['Token-2022 coin', TOKEN_2022_PROGRAM_ID],
  ['legacy SPL coin', TOKEN_PROGRAM_ID],
])('v2 trade instructions (%s)', (_label, tokenProgram) => {
  it('buy_v2 is byte-identical to the official SDK', async () => {
    const a = accounts(tokenProgram)
    const mine = buyV2Ix(a, 123_456_789n, 987_654_321n)
    const ref: TransactionInstruction = await sdk.PUMP_SDK.getBuyV2InstructionRaw(sdkArgs(a, 123_456_789n, 987_654_321n))
    expect(mine.programId.equals(ref.programId)).toBe(true)
    expect(flatKeys(mine)).toEqual(flatKeys(ref))
    expect(mine.data.toString('hex')).toBe(ref.data.toString('hex'))
    expect(mine.keys).toHaveLength(27)
  })

  it('sell_v2 is byte-identical to the official SDK', async () => {
    const a = accounts(tokenProgram)
    const mine = sellV2Ix(a, 5_000_000n, 42n)
    const ref: TransactionInstruction = await sdk.PUMP_SDK.getSellV2InstructionRaw(sdkArgs(a, 5_000_000n, 42n))
    expect(flatKeys(mine)).toEqual(flatKeys(ref))
    expect(mine.data.toString('hex')).toBe(ref.data.toString('hex'))
    expect(mine.keys).toHaveLength(26)
  })

  it('buy_exact_quote_in_v2 uses the buy_v2 accounts and IDL-encoded args', async () => {
    const a = accounts(tokenProgram)
    const mine = buyExactQuoteInV2Ix(a, 50_000_000n, 1_234_567n)
    const ref: TransactionInstruction = await sdk.PUMP_SDK.getBuyV2InstructionRaw(sdkArgs(a, 1n, 1n))
    expect(flatKeys(mine)).toEqual(flatKeys(ref))
    const expected = pumpCoder.instruction.encode('buy_exact_quote_in_v2', {
      spendable_quote_in: bn(50_000_000n),
      min_tokens_out: bn(1_234_567n),
    })
    expect(mine.data.toString('hex')).toBe(expected.toString('hex'))
  })
})

describe('token helpers', () => {
  it('createAtaIdempotent matches spl-token', async () => {
    const { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } = await import('@solana/spl-token')
    const payer = Keypair.generate().publicKey
    const mint = Keypair.generate().publicKey
    const ata = getAssociatedTokenAddressSync(mint, payer, true, TOKEN_2022_PROGRAM_ID)
    const ref = createAssociatedTokenAccountIdempotentInstruction(payer, ata, payer, mint, TOKEN_2022_PROGRAM_ID)
    const mine = createAtaIdempotentIx(payer, payer, mint, TOKEN_2022_PROGRAM_ID)
    expect(flatKeys(mine)).toEqual(flatKeys(ref))
    expect(mine.data.toString('hex')).toBe(ref.data.toString('hex'))
    expect(mine.programId.equals(ref.programId)).toBe(true)
  })
})
