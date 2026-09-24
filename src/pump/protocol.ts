import { PublicKey } from '@solana/web3.js'
import type { RpcClient } from '../solana/rpc.js'
import type { Logger } from '../util/logger.js'
import {
  FALLBACK_BUYBACK_FEE_RECIPIENTS,
  FALLBACK_FEE_RECIPIENTS,
  FALLBACK_RESERVED_FEE_RECIPIENTS,
} from './constants.js'
import type { CurveState, FeeContext } from './curve.js'
import { type FeeConfig, type Global, decodeFeeConfig, decodeGlobal } from './layouts.js'
import { FEE_CONFIG_PDA, GLOBAL_PDA } from './pda.js'

/** Launch parameters in force at the time of writing; replaced by the live Global account. */
const DEFAULT_INITIAL = {
  virtualTokenReserves: 1_073_000_000_000_000n,
  virtualQuoteReserves: 30_000_000_000n,
  realTokenReserves: 793_100_000_000_000n,
  tokenTotalSupply: 1_000_000_000_000_000n,
}

const nonZero = (keys: PublicKey[]) => keys.filter((k) => !k.equals(PublicKey.default))
const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!

/**
 * Live pump protocol parameters (Global + FeeConfig). Refreshed in the
 * background so fee math and fee-recipient selection track admin changes
 * without adding latency to trades.
 */
export class PumpProtocol {
  global: Global | null = null
  feeConfig: FeeConfig | null = null
  private timer?: NodeJS.Timeout
  private feeRecipients = FALLBACK_FEE_RECIPIENTS
  private reservedFeeRecipients = FALLBACK_RESERVED_FEE_RECIPIENTS
  private buybackFeeRecipients = FALLBACK_BUYBACK_FEE_RECIPIENTS

  constructor(
    private readonly rpc: RpcClient,
    private readonly log: Logger,
  ) {}

  async start(refreshMs = 60_000): Promise<void> {
    await this.refresh()
    this.timer = setInterval(() => void this.refresh().catch((err) => this.log.warn({ err: err.message }, 'protocol refresh failed')), refreshMs)
  }

  stop(): void {
    clearInterval(this.timer)
  }

  async refresh(): Promise<void> {
    const [g, f] = await this.rpc.getMultipleAccounts([GLOBAL_PDA, FEE_CONFIG_PDA])
    if (!g) throw new Error('pump Global account not found (wrong cluster?)')
    this.global = decodeGlobal(g.data)
    this.feeConfig = f ? decodeFeeConfig(f.data) : null

    const normal = nonZero([this.global.feeRecipient, ...this.global.feeRecipients])
    if (normal.length) this.feeRecipients = normal
    const reserved = nonZero([this.global.reservedFeeRecipient, ...this.global.reservedFeeRecipients])
    if (reserved.length) this.reservedFeeRecipients = reserved
    const buyback = nonZero(this.global.buybackFeeRecipients)
    if (buyback.length) this.buybackFeeRecipients = buyback
  }

  feeContext(): FeeContext {
    return { global: this.global, feeConfig: this.feeConfig }
  }

  /** Accounts every pump trade write-locks; used to sample priority fees. */
  hotAccounts(): PublicKey[] {
    return this.feeRecipients.slice(0, 4)
  }

  feeRecipient(mayhem: boolean): PublicKey {
    return pick(mayhem ? this.reservedFeeRecipients : this.feeRecipients)
  }

  buybackFeeRecipient(): PublicKey {
    return pick(this.buybackFeeRecipients)
  }

  get initialRealTokenReserves(): bigint {
    return this.global?.initialRealTokenReserves || DEFAULT_INITIAL.realTokenReserves
  }

  /** The curve `create_v2` starts from for a SOL-paired coin. */
  initialCurve(creator: PublicKey, isMayhemMode: boolean): CurveState {
    const g = this.global
    return {
      virtualTokenReserves: g?.initialVirtualTokenReserves || DEFAULT_INITIAL.virtualTokenReserves,
      virtualQuoteReserves: g?.initialVirtualSolReserves || DEFAULT_INITIAL.virtualQuoteReserves,
      realTokenReserves: g?.initialRealTokenReserves || DEFAULT_INITIAL.realTokenReserves,
      realQuoteReserves: 0n,
      tokenTotalSupply: g?.tokenTotalSupply || DEFAULT_INITIAL.tokenTotalSupply,
      complete: false,
      creator,
      isMayhemMode,
      creatorFeeBps: 0n,
    }
  }
}
