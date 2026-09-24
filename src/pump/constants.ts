import { PublicKey, SystemProgram } from '@solana/web3.js'

// Programs -------------------------------------------------------------------

export const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')
export const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA')
export const PUMP_FEE_PROGRAM_ID = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ')
export const MAYHEM_PROGRAM_ID = new PublicKey('MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e')

export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
export const SYSTEM_PROGRAM_ID = SystemProgram.programId
export const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey('ComputeBudget111111111111111111111111111111')

/** Wrapped SOL. The v2 trade instructions take it as `quote_mint` for SOL-paired coins. */
export const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112')
export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')

// Token economics ------------------------------------------------------------

export const PUMP_TOKEN_DECIMALS = 6
/** Supply used by the fee program's market-cap tiers for non-mayhem coins. */
export const ONE_BILLION_SUPPLY = 1_000_000_000_000_000n
export const LAMPORTS_PER_SOL = 1_000_000_000n

// Discriminators (from the published IDL, verified in test/idl.test.ts) -------

const d = (...b: number[]) => Uint8Array.from(b)

export const IX = {
  create: d(24, 30, 200, 40, 5, 28, 7, 119),
  createV2: d(214, 144, 76, 236, 95, 139, 49, 180),
  buy: d(102, 6, 61, 18, 1, 218, 235, 234),
  buyExactSolIn: d(56, 252, 116, 8, 158, 223, 205, 95),
  buyV2: d(184, 23, 238, 97, 103, 197, 211, 61),
  buyExactQuoteInV2: d(194, 171, 28, 70, 104, 77, 91, 47),
  sell: d(51, 230, 133, 164, 1, 127, 131, 173),
  sellV2: d(93, 246, 130, 60, 231, 233, 64, 178),
} as const

export const ACCOUNT = {
  bondingCurve: d(23, 183, 248, 55, 96, 216, 172, 96),
  global: d(167, 232, 232, 177, 200, 108, 114, 127),
  feeConfig: d(143, 52, 146, 187, 219, 123, 76, 155),
} as const

export const EVENT = {
  create: d(27, 114, 169, 77, 222, 235, 99, 118),
  trade: d(189, 219, 127, 211, 78, 230, 97, 238),
  complete: d(95, 114, 97, 156, 212, 46, 152, 8),
  completeAmmMigration: d(189, 233, 93, 185, 92, 148, 234, 148),
} as const

/** Anchor `emit_cpi!` self-invocation prefix (`EVENT_IX_TAG`, little-endian). */
export const ANCHOR_EVENT_IX_TAG = d(0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d)

// Fee recipients (docs/FEE_RECIPIENTS.md). Used only if the Global account ----
// cannot be read; the live Global account is authoritative.

export const FALLBACK_FEE_RECIPIENTS = [
  '62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV',
  '7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ',
  '7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX',
  '9rPYyANsfQZw3DnDmKE3YCQF5E8oD89UXoHn9JFEhJUz',
  'AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY',
  'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM',
  'FWsW1xNtWscwNmKv6wVsU1iTzRN6wmmk3MjxRP5tT7hz',
  'G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP',
].map((k) => new PublicKey(k))

export const FALLBACK_RESERVED_FEE_RECIPIENTS = [
  'GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS',
  '4budycTjhs9fD6xw62VBducVTNgMgJJ5BgtKq7mAZwn6',
  '8SBKzEQU4nLSzcwF4a74F2iaUDQyTfjGndn6qUWBnrpR',
  '4UQeTP1T39KZ9Sfxzo3WR5skgsaP6NZa87BAkuazLEKH',
  '8sNeir4QsLsJdYpc9RZacohhK1Y5FLU3nC5LXgYB4aa6',
  'Fh9HmeLNUMVCvejxCtCL2DbYaRyBFVJ5xrWkLnMH6fdk',
  '463MEnMeGyJekNZFQSTUABBEbLnvMTALbT6ZmsxAbAdq',
  '6AUH3WEHucYZyC61hqpqYUWVto5qA5hjHuNQ32GNnNxA',
].map((k) => new PublicKey(k))

export const FALLBACK_BUYBACK_FEE_RECIPIENTS = [
  '5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD',
  '9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7',
  'GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL',
  '3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR',
  '5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6',
  'EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL',
  '5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD',
  'A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW',
].map((k) => new PublicKey(k))
