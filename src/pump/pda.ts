import { PublicKey } from '@solana/web3.js'
import { LruCache } from '../util/lru.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  PUMP_FEE_PROGRAM_ID,
  PUMP_PROGRAM_ID,
} from './constants.js'

// `findProgramAddressSync` hashes repeatedly until it leaves the curve, so it
// costs tens of microseconds per call. Static PDAs are computed once at load;
// per-mint/per-owner ones go through a bounded cache.

const pda = (seeds: Uint8Array[], program: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync(seeds, program)[0]

const seed = (s: string) => Buffer.from(s, 'utf8')

export const GLOBAL_PDA = pda([seed('global')], PUMP_PROGRAM_ID)
export const EVENT_AUTHORITY_PDA = pda([seed('__event_authority')], PUMP_PROGRAM_ID)
export const GLOBAL_VOLUME_ACCUMULATOR_PDA = pda([seed('global_volume_accumulator')], PUMP_PROGRAM_ID)
export const FEE_CONFIG_PDA = pda([seed('fee_config'), PUMP_PROGRAM_ID.toBytes()], PUMP_FEE_PROGRAM_ID)

const cache = new LruCache<string, PublicKey>(50_000)

function cached(kind: string, key: PublicKey, derive: () => PublicKey): PublicKey {
  return cache.getOrCreate(`${kind}:${key.toBase58()}`, derive)
}

export function bondingCurvePda(mint: PublicKey): PublicKey {
  return cached('bc', mint, () => pda([seed('bonding-curve'), mint.toBytes()], PUMP_PROGRAM_ID))
}

export function creatorVaultPda(creator: PublicKey): PublicKey {
  return cached('cv', creator, () => pda([seed('creator-vault'), creator.toBytes()], PUMP_PROGRAM_ID))
}

export function userVolumeAccumulatorPda(user: PublicKey): PublicKey {
  return cached('uva', user, () => pda([seed('user_volume_accumulator'), user.toBytes()], PUMP_PROGRAM_ID))
}

/** Creator of a holder-rewards coin: fees accrue to this PDA's creator vault. */
export function holderRewardsPda(mint: PublicKey): PublicKey {
  return cached('hr', mint, () => pda([seed('holder-rewards'), mint.toBytes()], PUMP_PROGRAM_ID))
}

export function sharingConfigPda(mint: PublicKey): PublicKey {
  return cached('sc', mint, () => pda([seed('sharing-config'), mint.toBytes()], PUMP_FEE_PROGRAM_ID))
}

export function associatedTokenAddress(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  const key = `ata:${owner.toBase58()}:${mint.toBase58()}:${tokenProgram.toBase58()}`
  return cache.getOrCreate(key, () =>
    pda([owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()], ASSOCIATED_TOKEN_PROGRAM_ID),
  )
}
