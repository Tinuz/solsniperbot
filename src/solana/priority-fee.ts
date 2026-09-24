import type { PublicKey } from '@solana/web3.js'
import type { Config } from '../config.js'
import type { Logger } from '../util/logger.js'
import type { RpcClient } from './rpc.js'

export type Side = 'buy' | 'sell'

/**
 * Converts the configured priority budget into a compute-unit price.
 *
 * `fixed`: spend exactly the configured lamports per transaction.
 * `dynamic`: track a percentile of recent fees paid by transactions that
 * write-lock pump's fee recipients (every pump trade does), floored at the
 * configured amount and capped at PRIORITY_FEE_MAX_SOL. Sampling runs in the
 * background; reading the price is synchronous.
 */
export class PriorityFees {
  private sampledMicroLamports = 0n
  private timer?: NodeJS.Timeout

  constructor(
    private readonly cfg: Config,
    private readonly rpc: RpcClient,
    private readonly log: Logger,
    private readonly hotAccounts: () => PublicKey[],
  ) {}

  start(): void {
    if (this.cfg.priorityFeeMode !== 'dynamic') return
    void this.sample()
    this.timer = setInterval(() => void this.sample(), 5_000)
  }

  stop(): void {
    clearInterval(this.timer)
  }

  /** micro-lamports per compute unit for a transaction with `computeUnits` limit. */
  microLamportsPerCu(side: Side, computeUnits: number): bigint {
    const budget = side === 'buy' ? this.cfg.buyPriorityLamports : this.cfg.sellPriorityLamports
    const cu = BigInt(computeUnits)
    const floor = (budget * 1_000_000n) / cu
    if (this.cfg.priorityFeeMode === 'fixed') return floor
    const cap = (this.cfg.maxPriorityLamports * 1_000_000n) / cu
    const price = this.sampledMicroLamports > floor ? this.sampledMicroLamports : floor
    return price < cap ? price : cap
  }

  get sampled(): bigint {
    return this.sampledMicroLamports
  }

  private async sample(): Promise<void> {
    try {
      const fees = await this.rpc.getRecentPrioritizationFees(this.hotAccounts())
      const values = fees
        .map((f) => f.prioritizationFee)
        .filter((v) => v > 0)
        .sort((a, b) => a - b)
      if (values.length === 0) return
      const idx = Math.min(values.length - 1, Math.floor((this.cfg.priorityFeePercentile / 100) * values.length))
      this.sampledMicroLamports = BigInt(values[idx]!)
    } catch (err) {
      this.log.debug({ err: (err as Error).message }, 'priority fee sample failed')
    }
  }
}
