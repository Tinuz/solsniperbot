import { Keypair, PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { decodeBondingCurve, decodeFeeConfig, decodeGlobal } from '../src/pump/layouts.js'
import { big, bn, encodeAccount, feesCoder, pumpCoder, sdk } from './helpers.js'

const key = () => Keypair.generate().publicKey
const keys = (n: number) => Array.from({ length: n }, key)
const info = (data: Buffer) => ({ data, owner: PublicKey.default, lamports: 0, executable: false })

const curveFields = () => ({
  virtual_token_reserves: bn(1_022_000_000_000_000n),
  virtual_quote_reserves: bn(31_500_000_000n),
  real_token_reserves: bn(742_100_000_000_000n),
  real_quote_reserves: bn(1_500_000_000n),
  token_total_supply: bn(1_000_000_000_000_000n),
  complete: false,
  creator: key(),
  is_mayhem_mode: true,
  is_cashback_coin: false,
  quote_mint: PublicKey.default,
  creator_fee_bps: bn(0),
  can_edit_creator_fee: false,
  is_holder_reward: true,
})

describe('BondingCurve', () => {
  it('matches the SDK decoder on a full-length account', async () => {
    const fields = curveFields()
    const data = await pumpCoder.accounts.encode('BondingCurve', fields)
    const mine = decodeBondingCurve(data)
    const ref = sdk.PUMP_SDK.decodeBondingCurve(info(data))
    expect(mine.virtualTokenReserves).toBe(big(ref.virtualTokenReserves))
    expect(mine.virtualQuoteReserves).toBe(big(ref.virtualQuoteReserves))
    expect(mine.realTokenReserves).toBe(big(ref.realTokenReserves))
    expect(mine.realQuoteReserves).toBe(big(ref.realQuoteReserves))
    expect(mine.creator.equals(ref.creator)).toBe(true)
    expect(mine.isMayhemMode).toBe(ref.isMayhemMode)
    expect(mine.isHolderReward).toBe(ref.isHolderReward)
    expect(mine.complete).toBe(false)
  })

  it('reads a pre-holder-reward (124 byte) account as a regular coin', async () => {
    const data = (await pumpCoder.accounts.encode('BondingCurve', curveFields())).subarray(0, 124)
    expect(decodeBondingCurve(data).isHolderReward).toBe(false)
  })

  it('rejects other accounts', () => {
    expect(() => decodeBondingCurve(Buffer.alloc(125))).toThrow()
  })
})

describe('Global', () => {
  it('matches the SDK decoder field-for-field', async () => {
    const fields = {
      initialized: true,
      authority: key(),
      fee_recipient: key(),
      initial_virtual_token_reserves: bn(1_073_000_000_000_000n),
      initial_virtual_sol_reserves: bn(30_000_000_000n),
      initial_real_token_reserves: bn(793_100_000_000_000n),
      token_total_supply: bn(1_000_000_000_000_000n),
      fee_basis_points: bn(95),
      withdraw_authority: key(),
      enable_migrate: false,
      pool_migration_fee: bn(15_000_001n),
      creator_fee_basis_points: bn(30),
      fee_recipients: keys(7),
      set_creator_authority: key(),
      admin_set_creator_authority: key(),
      create_v2_enabled: true,
      whitelist_pda: key(),
      reserved_fee_recipient: key(),
      mayhem_mode_enabled: true,
      reserved_fee_recipients: keys(7),
      is_cashback_enabled: false,
      buyback_fee_recipients: keys(8),
      buyback_basis_points: bn(500),
      initial_virtual_quote_reserves: bn(4_200_000_000n),
      whitelisted_quote_mints: keys(1),
      creator_fee_configurable: true,
      max_configurable_creator_fee_bps: bn(250),
      holder_reward_claim_authority: key(),
      is_holder_reward_enabled: true,
    }
    const data = encodeAccount(pumpCoder, 'Global', fields)
    const mine = decodeGlobal(data)
    const ref = sdk.PUMP_SDK.decodeGlobal(info(data))
    expect(mine.feeRecipient.equals(ref.feeRecipient)).toBe(true)
    expect(mine.feeRecipients.map(String)).toEqual(ref.feeRecipients.map(String))
    expect(mine.reservedFeeRecipient.equals(ref.reservedFeeRecipient)).toBe(true)
    expect(mine.reservedFeeRecipients.map(String)).toEqual(ref.reservedFeeRecipients.map(String))
    expect(mine.buybackFeeRecipients.map(String)).toEqual(ref.buybackFeeRecipients.map(String))
    expect(mine.initialRealTokenReserves).toBe(big(ref.initialRealTokenReserves))
    expect(mine.feeBasisPoints).toBe(big(ref.feeBasisPoints))
    expect(mine.creatorFeeBasisPoints).toBe(big(ref.creatorFeeBasisPoints))
    expect(mine.buybackBasisPoints).toBe(big(ref.buybackBasisPoints))
    expect(mine.initialVirtualQuoteReserves).toBe(big(ref.initialVirtualQuoteReserves))
    expect(mine.creatorFeeConfigurable).toBe(ref.creatorFeeConfigurable)
    expect(mine.maxConfigurableCreatorFeeBps).toBe(big(ref.maxConfigurableCreatorFeeBps))
    expect(mine.isHolderRewardEnabled).toBe(ref.isHolderRewardEnabled)
    expect(mine.mayhemModeEnabled).toBe(true)
  })
})

describe('FeeConfig', () => {
  it('decodes tiers identically to the SDK', async () => {
    const fees = (lp: number, p: number, c: number) => ({ lp_fee_bps: bn(lp), protocol_fee_bps: bn(p), creator_fee_bps: bn(c) })
    const fields = {
      bump: 255,
      admin: key(),
      flat_fees: fees(0, 95, 30),
      fee_tiers: [
        { market_cap_lamports_threshold: bn(0), fees: fees(0, 95, 30) },
        { market_cap_lamports_threshold: bn(420_000_000_000n), fees: fees(20, 5, 95) },
        { market_cap_lamports_threshold: bn(1_470_000_000_000n), fees: fees(20, 5, 90) },
      ],
      stable_fee_tiers: [{ market_cap_lamports_threshold: bn(0), fees: fees(0, 90, 30) }],
      exotic_flat_fees: fees(0, 100, 50),
    }
    // Live FeeConfig accounts are allocated at a fixed, zero-padded size.
    const data = encodeAccount(feesCoder, 'FeeConfig', fields, 2512)
    const mine = decodeFeeConfig(data)
    const ref = sdk.PUMP_SDK.decodeFeeConfig(info(data))
    expect(mine.feeTiers).toHaveLength(3)
    mine.feeTiers.forEach((tier, i) => {
      expect(tier.marketCapLamportsThreshold).toBe(big(ref.feeTiers[i].marketCapLamportsThreshold))
      expect(tier.fees.protocolFeeBps).toBe(big(ref.feeTiers[i].fees.protocolFeeBps))
      expect(tier.fees.creatorFeeBps).toBe(big(ref.feeTiers[i].fees.creatorFeeBps))
    })
    expect(mine.stableFeeTiers).toHaveLength(1)
    expect(mine.exoticFlatFees.protocolFeeBps).toBe(100n)
  })
})
