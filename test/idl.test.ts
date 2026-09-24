import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import {
  ACCOUNT,
  EVENT,
  IX,
  PUMP_FEE_PROGRAM_ID,
  PUMP_PROGRAM_ID,
} from '../src/pump/constants.js'
import { EVENT_AUTHORITY_PDA, FEE_CONFIG_PDA, GLOBAL_PDA, GLOBAL_VOLUME_ACCUMULATOR_PDA } from '../src/pump/pda.js'
import { pumpIdl, sdk } from './helpers.js'

type Named = { name: string; discriminator: number[] }
const find = (list: Named[] | undefined, name: string) => {
  const hit = list?.find((x) => x.name === name)
  if (!hit) throw new Error(`${name} missing from IDL`)
  return Uint8Array.from(hit.discriminator)
}

describe('discriminators match the published IDL', () => {
  const ixs = pumpIdl.instructions as unknown as Named[]
  it.each([
    ['create', IX.create],
    ['create_v2', IX.createV2],
    ['buy', IX.buy],
    ['buy_exact_sol_in', IX.buyExactSolIn],
    ['buy_v2', IX.buyV2],
    ['buy_exact_quote_in_v2', IX.buyExactQuoteInV2],
    ['sell', IX.sell],
    ['sell_v2', IX.sellV2],
  ])('instruction %s', (name, disc) => {
    expect(disc).toEqual(find(ixs, name))
  })

  it.each([
    ['BondingCurve', ACCOUNT.bondingCurve],
    ['Global', ACCOUNT.global],
    ['FeeConfig', ACCOUNT.feeConfig],
  ])('account %s', (name, disc) => {
    expect(disc).toEqual(find(pumpIdl.accounts as unknown as Named[], name))
  })

  it.each([
    ['CreateEvent', EVENT.create],
    ['TradeEvent', EVENT.trade],
    ['CompleteEvent', EVENT.complete],
    ['CompletePumpAmmMigrationEvent', EVENT.completeAmmMigration],
  ])('event %s', (name, disc) => {
    expect(disc).toEqual(find(pumpIdl.events as unknown as Named[], name))
  })
})

describe('static PDAs', () => {
  it('match the SDK', () => {
    expect(GLOBAL_PDA.equals(sdk.GLOBAL_PDA)).toBe(true)
    expect(EVENT_AUTHORITY_PDA.equals(sdk.PUMP_EVENT_AUTHORITY_PDA)).toBe(true)
    expect(GLOBAL_VOLUME_ACCUMULATOR_PDA.equals(sdk.GLOBAL_VOLUME_ACCUMULATOR_PDA)).toBe(true)
    expect(FEE_CONFIG_PDA.equals(sdk.PUMP_FEE_CONFIG_PDA)).toBe(true)
  })

  it('fee_config and sharing_config seeds reference the expected programs', () => {
    const buyV2 = (pumpIdl.instructions as unknown as { name: string; accounts: any[] }[]).find((i) => i.name === 'buy_v2')!
    const feeConfig = buyV2.accounts.find((a) => a.name === 'fee_config')
    expect(new PublicKey(Uint8Array.from(feeConfig.pda.seeds[1].value)).equals(PUMP_PROGRAM_ID)).toBe(true)
    const sharing = buyV2.accounts.find((a) => a.name === 'sharing_config')
    expect(new PublicKey(Uint8Array.from(sharing.pda.program.value)).equals(PUMP_FEE_PROGRAM_ID)).toBe(true)
  })
})
