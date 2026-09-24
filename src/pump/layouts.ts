import { PublicKey } from '@solana/web3.js'
import { BorshReader, discriminatorEquals } from '../util/borsh.js'
import { ACCOUNT } from './constants.js'

export interface Fees {
  lpFeeBps: bigint
  protocolFeeBps: bigint
  creatorFeeBps: bigint
}

export interface FeeTier {
  marketCapLamportsThreshold: bigint
  fees: Fees
}

export interface FeeConfig {
  admin: PublicKey
  flatFees: Fees
  feeTiers: FeeTier[]
  stableFeeTiers: FeeTier[]
  exoticFlatFees: Fees
}

export interface Global {
  authority: PublicKey
  feeRecipient: PublicKey
  initialVirtualTokenReserves: bigint
  initialVirtualSolReserves: bigint
  initialRealTokenReserves: bigint
  tokenTotalSupply: bigint
  feeBasisPoints: bigint
  creatorFeeBasisPoints: bigint
  feeRecipients: PublicKey[]
  createV2Enabled: boolean
  reservedFeeRecipient: PublicKey
  mayhemModeEnabled: boolean
  reservedFeeRecipients: PublicKey[]
  buybackFeeRecipients: PublicKey[]
  buybackBasisPoints: bigint
  initialVirtualQuoteReserves: bigint
  creatorFeeConfigurable: boolean
  maxConfigurableCreatorFeeBps: bigint
  isHolderRewardEnabled: boolean
}

/** Decoded pump `BondingCurve`. Quote fields hold lamports for SOL-paired coins. */
export interface BondingCurve {
  virtualTokenReserves: bigint
  virtualQuoteReserves: bigint
  realTokenReserves: bigint
  realQuoteReserves: bigint
  tokenTotalSupply: bigint
  complete: boolean
  creator: PublicKey
  isMayhemMode: boolean
  isCashbackCoin: boolean
  /** `PublicKey.default` for SOL-paired coins. */
  quoteMint: PublicKey
  creatorFeeBps: bigint
  isHolderReward: boolean
}

function reader(data: Uint8Array, disc: Uint8Array, name: string): BorshReader {
  if (!discriminatorEquals(data, disc)) throw new Error(`account is not a pump ${name}`)
  return new BorshReader(data, 8)
}

const pubkeys = (r: BorshReader, n: number) => Array.from({ length: n }, () => r.pubkey())

export function decodeGlobal(data: Uint8Array): Global {
  const r = reader(data, ACCOUNT.global, 'Global')
  r.bool() // initialized (unused)
  const authority = r.pubkey()
  const feeRecipient = r.pubkey()
  const initialVirtualTokenReserves = r.u64()
  const initialVirtualSolReserves = r.u64()
  const initialRealTokenReserves = r.u64()
  const tokenTotalSupply = r.u64()
  const feeBasisPoints = r.u64()
  r.pubkey() // withdraw_authority
  r.bool() // enable_migrate (unused)
  r.u64() // pool_migration_fee
  const creatorFeeBasisPoints = r.u64()
  const feeRecipients = pubkeys(r, 7)
  r.pubkey() // set_creator_authority
  r.pubkey() // admin_set_creator_authority
  const createV2Enabled = r.bool()
  r.pubkey() // whitelist_pda
  const reservedFeeRecipient = r.pubkey()
  const mayhemModeEnabled = r.bool()
  const reservedFeeRecipients = pubkeys(r, 7)
  r.bool() // is_cashback_enabled
  const buybackFeeRecipients = pubkeys(r, 8)
  const buybackBasisPoints = r.u64()
  const initialVirtualQuoteReserves = r.u64()
  r.pubkey() // whitelisted_quote_mints[0]
  const creatorFeeConfigurable = r.bool()
  const maxConfigurableCreatorFeeBps = r.u64()
  r.pubkey() // holder_reward_claim_authority
  const isHolderRewardEnabled = r.bool()
  return {
    authority,
    feeRecipient,
    initialVirtualTokenReserves,
    initialVirtualSolReserves,
    initialRealTokenReserves,
    tokenTotalSupply,
    feeBasisPoints,
    creatorFeeBasisPoints,
    feeRecipients,
    createV2Enabled,
    reservedFeeRecipient,
    mayhemModeEnabled,
    reservedFeeRecipients,
    buybackFeeRecipients,
    buybackBasisPoints,
    initialVirtualQuoteReserves,
    creatorFeeConfigurable,
    maxConfigurableCreatorFeeBps,
    isHolderRewardEnabled,
  }
}

export function decodeBondingCurve(data: Uint8Array): BondingCurve {
  const r = reader(data, ACCOUNT.bondingCurve, 'BondingCurve')
  const virtualTokenReserves = r.u64()
  const virtualQuoteReserves = r.u64()
  const realTokenReserves = r.u64()
  const realQuoteReserves = r.u64()
  const tokenTotalSupply = r.u64()
  const complete = r.bool()
  const creator = r.pubkey()
  const isMayhemMode = r.bool()
  const isCashbackCoin = r.bool()
  const quoteMint = r.pubkey()
  const creatorFeeBps = r.u64()
  r.bool() // can_edit_creator_fee
  const isHolderReward = r.bool()
  return {
    virtualTokenReserves,
    virtualQuoteReserves,
    realTokenReserves,
    realQuoteReserves,
    tokenTotalSupply,
    complete,
    creator,
    isMayhemMode,
    isCashbackCoin,
    quoteMint,
    creatorFeeBps,
    isHolderReward,
  }
}

const readFees = (r: BorshReader): Fees => ({
  lpFeeBps: r.u64(),
  protocolFeeBps: r.u64(),
  creatorFeeBps: r.u64(),
})

const readFeeTier = (r: BorshReader): FeeTier => ({
  marketCapLamportsThreshold: r.u128(),
  fees: readFees(r),
})

export function decodeFeeConfig(data: Uint8Array): FeeConfig {
  const r = reader(data, ACCOUNT.feeConfig, 'FeeConfig')
  r.u8() // bump
  const admin = r.pubkey()
  const flatFees = readFees(r)
  const feeTiers = r.vec(readFeeTier, 64)
  const stableFeeTiers = r.vec(readFeeTier, 64)
  const exoticFlatFees = readFees(r)
  return { admin, flatFees, feeTiers, stableFeeTiers, exoticFlatFees }
}
