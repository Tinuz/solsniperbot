import type { Logger } from '../util/logger.js'
import type { BlockhashCache } from './blockhash.js'
import type { Lander } from './landing.js'
import type { RpcClient } from './rpc.js'

export type TxOutcome =
  | { status: 'landed'; slot: number; via: 'stream' | 'rpc' }
  | { status: 'failed'; slot: number; err: unknown; via: 'stream' | 'rpc' }
  | { status: 'expired' }
  /** The bot stopped watching before the outcome was known: the transaction may still land. */
  | { status: 'aborted' }

interface Entry {
  resolve: (o: TxOutcome) => void
  lastValidBlockHeight: number
  base64?: string
  rebroadcasts: number
  nextRebroadcastAt: number
}

/**
 * Resolves transaction outcomes from whichever source reports first:
 * the live program stream (our own trade shows up at `processed`), or
 * batched `getSignatureStatuses` polling. Also re-broadcasts to plain RPCs
 * until the transaction lands or its blockhash expires.
 */
export class SignatureTracker {
  private readonly pending = new Map<string, Entry>()
  private timer?: NodeJS.Timeout
  private polling = false

  constructor(
    private readonly rpc: RpcClient,
    private readonly blockhash: BlockhashCache,
    private readonly lander: Lander | undefined,
    private readonly opts: { pollMs: number; rebroadcastMs: number; rebroadcastMax: number },
    private readonly log: Logger,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.poll(), this.opts.pollMs)
  }

  /**
   * Stops polling and re-broadcasting. Transactions still pending resolve as
   * `aborted`, never as failed: they may land after all, so their positions
   * are kept and resolved on-chain at the next start.
   */
  stop(): void {
    clearInterval(this.timer)
    for (const [sig, e] of this.pending) {
      e.resolve({ status: 'aborted' })
      this.pending.delete(sig)
    }
  }

  get size(): number {
    return this.pending.size
  }

  track(signature: string, lastValidBlockHeight: number, base64?: string): Promise<TxOutcome> {
    return new Promise((resolve) => {
      this.pending.set(signature, {
        resolve,
        lastValidBlockHeight,
        base64,
        rebroadcasts: 0,
        nextRebroadcastAt: Date.now() + this.opts.rebroadcastMs,
      })
    })
  }

  /** Called by the feed for every transaction it sees. Cheap map lookup. */
  observe(signature: string, err: unknown, slot: number): void {
    const e = this.pending.get(signature)
    if (!e) return
    this.pending.delete(signature)
    e.resolve(err ? { status: 'failed', slot, err, via: 'stream' } : { status: 'landed', slot, via: 'stream' })
  }

  private async poll(): Promise<void> {
    if (this.polling || this.pending.size === 0) return
    this.polling = true
    try {
      const now = Date.now()
      if (this.lander) {
        for (const e of this.pending.values()) {
          if (e.base64 && e.rebroadcasts < this.opts.rebroadcastMax && now >= e.nextRebroadcastAt) {
            e.rebroadcasts++
            e.nextRebroadcastAt = now + this.opts.rebroadcastMs
            void this.lander.rebroadcast(e.base64)
          }
        }
      }

      const sigs = [...this.pending.keys()].slice(0, 256)
      const statuses = await this.rpc.getSignatureStatuses(sigs)
      const height = this.blockhash.estimatedBlockHeight()
      sigs.forEach((sig, i) => {
        const e = this.pending.get(sig)
        if (!e) return
        const st = statuses[i]
        if (st && st.confirmationStatus) {
          this.pending.delete(sig)
          e.resolve(st.err ? { status: 'failed', slot: st.slot, err: st.err, via: 'rpc' } : { status: 'landed', slot: st.slot, via: 'rpc' })
        } else if (height > e.lastValidBlockHeight) {
          this.pending.delete(sig)
          e.resolve({ status: 'expired' })
        }
      })
    } catch (err) {
      this.log.debug({ err: (err as Error).message }, 'signature status poll failed')
    } finally {
      this.polling = false
    }
  }
}
