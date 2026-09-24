import { EventEmitter } from 'node:events'
import { PUMP_PROGRAM_ID } from '../pump/constants.js'
import { logsMayContainPumpEvents, parsePumpLogs } from '../pump/events.js'
import { SolanaWs } from '../solana/ws.js'
import type { Logger } from '../util/logger.js'
import { nowMs } from '../util/time.js'
import type { Feed, FeedStats, FeedTx } from './types.js'

interface LogsValue {
  signature: string
  err: unknown
  logs: string[] | null
}

/**
 * `logsSubscribe` on the pump program at `processed` commitment.
 *
 * Everything the bot needs (create args, curve reserves after the dev buy,
 * every trade) is decoded straight from the log lines, so detection costs zero
 * extra RPC round-trips.
 */
export class LogsFeed extends EventEmitter implements Feed {
  readonly name = 'ws' as const
  private readonly ws: SolanaWs
  private txs = 0

  constructor(wsUrl: string, private readonly log: Logger) {
    super()
    // Pump trades never pause for two minutes; silence means a dead subscription.
    this.ws = new SolanaWs(wsUrl, log, 'pump-logs', 120_000)
    this.ws.on('open', () => this.emit('status', true))
    this.ws.on('close', () => this.emit('status', false))
    this.ws.on('stall', (ms: number) =>
      this.emit('problem', `no data for ${Math.round(ms / 1000)}s although connected; reconnecting (RPC credits used up, or the subscription was dropped?)`),
    )
    this.ws.on('rejected', (message: string) => this.emit('problem', `subscription refused by the RPC: ${message}`))
  }

  async start(): Promise<void> {
    this.ws.subscribe(
      'logsSubscribe',
      [{ mentions: [PUMP_PROGRAM_ID.toBase58()] }, { commitment: 'processed' }],
      'logsUnsubscribe',
      (value, ctx) => this.onLogs(value as LogsValue, ctx.slot ?? 0),
    )
    this.ws.start()
  }

  stop(): void {
    this.ws.stop()
  }

  stats(): FeedStats {
    return {
      source: this.name,
      connected: this.ws.stats.connected,
      txs: this.txs,
      reconnects: this.ws.stats.reconnects,
      lastMessageAt: this.ws.stats.lastMessageAt,
      bytes: this.ws.stats.bytes,
      stalls: this.ws.stats.stalls,
    }
  }

  private onLogs(value: LogsValue, slot: number): void {
    const receivedAt = nowMs()
    this.txs++
    const logs = value.logs ?? []
    let events: FeedTx['events'] = []
    if (!value.err && logsMayContainPumpEvents(logs)) {
      try {
        events = parsePumpLogs(logs)
      } catch (err) {
        this.log.debug({ err: (err as Error).message, sig: value.signature }, 'failed to parse pump logs')
      }
    }
    this.emit('tx', { signature: value.signature, slot, err: value.err, events, receivedAt, source: this.name } satisfies FeedTx)
  }
}
