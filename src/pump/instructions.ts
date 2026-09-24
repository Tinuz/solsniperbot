import { type AccountMeta, PublicKey, TransactionInstruction } from '@solana/web3.js'
import { encodeU64Pair } from '../util/borsh.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  IX,
  NATIVE_MINT,
  PUMP_FEE_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from './constants.js'
import {
  EVENT_AUTHORITY_PDA,
  FEE_CONFIG_PDA,
  GLOBAL_PDA,
  GLOBAL_VOLUME_ACCUMULATOR_PDA,
  associatedTokenAddress,
  bondingCurvePda,
  creatorVaultPda,
  sharingConfigPda,
  userVolumeAccumulatorPda,
} from './pda.js'

/** Everything that varies between two SOL-paired v2 trades. */
export interface TradeAccounts {
  mint: PublicKey
  user: PublicKey
  /** `bonding_curve.creator` (the holder-rewards PDA for holder-reward coins). */
  creator: PublicKey
  /** Token program owning the base mint (Token-2022 for `create_v2` coins). */
  tokenProgram: PublicKey
  feeRecipient: PublicKey
  buybackFeeRecipient: PublicKey
}

const w = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true })
const r = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false })

const QUOTE_MINT = NATIVE_MINT
const QUOTE_TOKEN_PROGRAM = TOKEN_PROGRAM_ID

/**
 * Account list shared by `buy_v2`, `buy_exact_quote_in_v2` and `sell_v2`
 * (sells omit `global_volume_accumulator`). Order follows the IDL exactly.
 */
function v2TradeKeys(a: TradeAccounts, side: 'buy' | 'sell'): AccountMeta[] {
  const bondingCurve = bondingCurvePda(a.mint)
  const creatorVault = creatorVaultPda(a.creator)
  const userVolumeAccumulator = userVolumeAccumulatorPda(a.user)
  const quoteAta = (owner: PublicKey) => associatedTokenAddress(owner, QUOTE_MINT, QUOTE_TOKEN_PROGRAM)

  const keys: AccountMeta[] = [
    r(GLOBAL_PDA),
    r(a.mint),
    r(QUOTE_MINT),
    r(a.tokenProgram),
    r(QUOTE_TOKEN_PROGRAM),
    r(ASSOCIATED_TOKEN_PROGRAM_ID),
    w(a.feeRecipient),
    w(quoteAta(a.feeRecipient)),
    w(a.buybackFeeRecipient),
    w(quoteAta(a.buybackFeeRecipient)),
    w(bondingCurve),
    w(associatedTokenAddress(bondingCurve, a.mint, a.tokenProgram)),
    w(quoteAta(bondingCurve)),
    { pubkey: a.user, isSigner: true, isWritable: true },
    w(associatedTokenAddress(a.user, a.mint, a.tokenProgram)),
    w(quoteAta(a.user)),
    w(creatorVault),
    w(quoteAta(creatorVault)),
    r(sharingConfigPda(a.mint)),
  ]
  if (side === 'buy') keys.push(r(GLOBAL_VOLUME_ACCUMULATOR_PDA))
  keys.push(
    w(userVolumeAccumulator),
    w(quoteAta(userVolumeAccumulator)),
    r(FEE_CONFIG_PDA),
    r(PUMP_FEE_PROGRAM_ID),
    r(SYSTEM_PROGRAM_ID),
    r(EVENT_AUTHORITY_PDA),
    r(PUMP_PROGRAM_ID),
  )
  return keys
}

/** Spend exactly `spendableLamports` (fees included); fail below `minTokensOut`. */
export function buyExactQuoteInV2Ix(a: TradeAccounts, spendableLamports: bigint, minTokensOut: bigint) {
  return new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: v2TradeKeys(a, 'buy'),
    data: encodeU64Pair(IX.buyExactQuoteInV2, spendableLamports, minTokensOut),
  })
}

/** Buy exactly `tokenAmount`; fail if it costs more than `maxQuoteCost` lamports. */
export function buyV2Ix(a: TradeAccounts, tokenAmount: bigint, maxQuoteCost: bigint) {
  return new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: v2TradeKeys(a, 'buy'),
    data: encodeU64Pair(IX.buyV2, tokenAmount, maxQuoteCost),
  })
}

/** Sell exactly `tokenAmount`; fail below `minQuoteOut` lamports after fees. */
export function sellV2Ix(a: TradeAccounts, tokenAmount: bigint, minQuoteOut: bigint) {
  return new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: v2TradeKeys(a, 'sell'),
    data: encodeU64Pair(IX.sellV2, tokenAmount, minQuoteOut),
  })
}

// Token helpers (hand-built: avoids spl-token's layout machinery on the hot path)

export function createAtaIdempotentIx(payer: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey) {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      w(associatedTokenAddress(owner, mint, tokenProgram)),
      r(owner),
      r(mint),
      r(SYSTEM_PROGRAM_ID),
      r(tokenProgram),
    ],
    data: Buffer.from([1]),
  })
}

/** `CloseAccount`: returns the token account's rent to `destination`. Balance must be zero. */
export function closeTokenAccountIx(account: PublicKey, destination: PublicKey, owner: PublicKey, tokenProgram: PublicKey) {
  return new TransactionInstruction({
    programId: tokenProgram,
    keys: [w(account), w(destination), { pubkey: owner, isSigner: true, isWritable: false }],
    data: Buffer.from([9]),
  })
}
