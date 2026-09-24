import type { Logger } from '../util/logger.js'
import type { RpcClient } from './rpc.js'

export interface CachedBlockhash {
  blockhash: string
  lastValidBlockHeight: number
  fetchedAt: number
}

/** A blockhash is valid for 150 blocks after the one it was taken from. */
const VALIDITY_BLOCKS = 150

/**
 * Keeps a recent blockhash in memory so building a transaction never waits on
 * an RPC round-trip.
 */
export class BlockhashCache {
  private current?: CachedBlockhash
  private timer?: NodeJS.Timeout
  private failures = 0

  constructor(
    private readonly rpc: RpcClient,
    private readonly log: Logger,
    private readonly intervalMs = 1_000,
  ) {}

  async start(): Promise<void> {
    await this.refresh(true)
    this.timer = setInterval(() => void this.refresh(false), this.intervalMs)
  }

  stop(): void {
    clearInterval(this.timer)
  }

  get(): CachedBlockhash {
    if (!this.current) throw new Error('no blockhash available yet')
    return this.current
  }

  get ageMs(): number {
    return this.current ? Date.now() - this.current.fetchedAt : Number.POSITIVE_INFINITY
  }

  /** Block height as of the last refresh (the RPC reports `lastValid = height + 150`). */
  estimatedBlockHeight(): number {
    return this.current ? this.current.lastValidBlockHeight - VALIDITY_BLOCKS : 0
  }

  private async refresh(throwOnError: boolean): Promise<void> {
    try {
      const r = await this.rpc.getLatestBlockhash('confirmed')
      this.current = { blockhash: r.blockhash, lastValidBlockHeight: r.lastValidBlockHeight, fetchedAt: Date.now() }
      this.failures = 0
    } catch (err) {
      if (throwOnError) throw err
      this.failures++
      if (this.failures === 3 || this.failures % 30 === 0) {
        this.log.warn({ err: (err as Error).message, ageMs: this.ageMs }, 'blockhash refresh failing')
      }
    }
  }
}
