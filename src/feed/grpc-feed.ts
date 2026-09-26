import { EventEmitter } from 'node:events'
import { PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import { IX, PUMP_PROGRAM_ID } from '../pump/constants.js'
import {
  type BuyInstruction,
  type CreateInstruction,
  type PumpEvent,
  decodeCpiEventInstruction,
  decodePumpInstruction,
  parsePumpLogs,
} from '../pump/events.js'
import { discriminatorEquals } from '../util/borsh.js'
import type { Logger } from '../util/logger.js'
import { nowMs } from '../util/time.js'
import type { Feed, FeedStats, FeedTx, LaunchPreview } from './types.js'

// Structural types for the parts of the Yellowstone protobuf messages we read.
// The package is an optional dependency, so it is only loaded at runtime.
interface CompiledIx {
  programIdIndex: number
  accounts: Uint8Array
  data: Uint8Array
}
interface TxMessage {
  accountKeys: Uint8Array[]
  instructions: CompiledIx[]
}
interface TxUpdate {
  slot: string
  transaction?: {
    signature: Uint8Array
    transaction?: { message?: TxMessage }
    meta?: {
      err?: unknown
      logMessages: string[]
      innerInstructions: { instructions: CompiledIx[] }[]
      loadedWritableAddresses: Uint8Array[]
      loadedReadonlyAddresses: Uint8Array[]
    }
  }
}
interface DeshredUpdate {
  slot: string
  transaction?: {
    signature: Uint8Array
    transaction?: { message?: TxMessage }
    loadedWritableAddresses: Uint8Array[]
    loadedReadonlyAddresses: Uint8Array[]
  }
}
interface DuplexLike extends NodeJS.EventEmitter {
  write(req: unknown): boolean
  destroy(): void
}

const PUMP_BYTES = PUMP_PROGRAM_ID.toBytes()

function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== 32 || b.length !== 32) return false
  for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return false
  return true
}

const PING_MS = 15_000
/** Pings are answered, so this much silence means the stream is dead even if it looks open. */
const STALL_MS = 60_000
const MAX_REOPEN_DELAY_MS = 30_000

/**
 * Yellowstone gRPC feed (Triton, Helius LaserStream and compatible providers).
 *
 * - `subscribe`: executed pump transactions at `processed`, with the client's
 *   native reconnect + slot backfill so no launch is missed across a blip.
 * - `subscribeDeshred` (optional): transactions reassembled from shreds before
 *   the validator executes them, the earliest point a launch is observable.
 */
export class GrpcFeed extends EventEmitter implements Feed {
  readonly name = 'grpc' as const
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client?: any
  private stream?: DuplexLike
  private deshred?: DuplexLike
  private pingTimer?: NodeJS.Timeout
  private watchdog?: NodeJS.Timeout
  private reopenTimer?: NodeJS.Timeout
  private reopenDelay = 1_000
  private reopenFailures = 0
  private stalls = 0
  private decodeErrors = 0
  private stopped = false
  private connected = false
  private txs = 0
  private reconnects = 0
  private lastMessageAt = 0
  private pingId = 0
  private deshredBackoff = 500

  constructor(
    private readonly opts: { url: string; token?: string; deshred: boolean },
    private readonly log: Logger,
  ) {
    super()
  }

  private readonly txRequest = {
    accounts: {},
    slots: {},
    transactions: {
      pump: { vote: false, failed: true, accountInclude: [PUMP_PROGRAM_ID.toBase58()], accountExclude: [], accountRequired: [] },
    },
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
    commitment: 0, // CommitmentLevel.PROCESSED
  }

  async start(): Promise<void> {
    this.stopped = false
    let mod: { default: new (...args: unknown[]) => unknown }
    try {
      mod = (await import('@triton-one/yellowstone-grpc')) as unknown as typeof mod
    } catch (err) {
      throw new Error(`FEED=grpc needs @triton-one/yellowstone-grpc installed (${(err as Error).message})`)
    }
    const Client = mod.default
    this.client = new Client(
      this.opts.url,
      this.opts.token,
      {
        grpcMaxDecodingMessageSize: 64 * 1024 * 1024,
        grpcTcpNodelay: true,
        grpcHttp2KeepAliveInterval: 10_000,
        grpcKeepAliveTimeout: 5_000,
        grpcKeepAliveWhileIdle: true,
      },
      { backoff: { initialIntervalMs: 100, multiplier: 2, maxRetries: 1_000_000 }, slotRetention: 250 },
    )
    await this.client.connect()
    await this.openTxStream()
    if (this.opts.deshred) await this.openDeshred()
    this.pingTimer = setInterval(() => this.ping(), PING_MS)
    this.watchdog = setInterval(() => this.checkStall(), 10_000)
  }

  stop(): void {
    this.stopped = true
    clearInterval(this.pingTimer)
    clearInterval(this.watchdog)
    clearTimeout(this.reopenTimer)
    this.stream?.destroy()
    this.deshred?.destroy()
    this.connected = false
  }

  stats(): FeedStats {
    return { source: this.name, connected: this.connected, txs: this.txs, reconnects: this.reconnects, lastMessageAt: this.lastMessageAt, stalls: this.stalls }
  }

  private async openTxStream(): Promise<void> {
    const stream = (await this.client.subscribe(this.txRequest)) as DuplexLike
    this.stream = stream
    this.connected = true
    this.lastMessageAt = Date.now()
    this.emit('status', true)
    this.log.info({ deshred: this.opts.deshred }, 'gRPC stream connected')
    stream.on('data', (u: { transaction?: TxUpdate }) => {
      this.lastMessageAt = Date.now()
      if (!u.transaction) return
      try {
        this.onTransaction(u.transaction)
      } catch (err) {
        this.decodeFailed(err)
      }
    })
    stream.on('error', (err: Error) => this.log.warn({ err: err.message }, 'gRPC stream error'))
    stream.on('close', () => {
      // Replaced already (the watchdog gave up on it): the new one is in charge.
      if (this.stream !== stream) return
      this.stream = undefined
      this.connected = false
      this.emit('status', false)
      if (this.stopped) return
      // The native layer reconnects transparently; only a terminal close lands here.
      this.log.warn('gRPC stream closed, reopening')
      this.scheduleReopen()
    })
  }

  /** Reopens with growing delays until it works: a deaf feed means no launches and no prices for open positions. */
  private scheduleReopen(): void {
    if (this.stopped || this.reopenTimer) return
    const delay = this.reopenDelay
    this.reopenDelay = Math.min(this.reopenDelay * 2, MAX_REOPEN_DELAY_MS)
    this.reopenTimer = setTimeout(() => {
      this.reopenTimer = undefined
      if (this.stopped) return
      this.reconnects++
      this.openTxStream().then(
        () => {
          this.reopenDelay = 1_000
          this.reopenFailures = 0
        },
        (err: Error) => {
          this.reopenFailures++
          this.log.error({ err: err.message, tries: this.reopenFailures }, 'gRPC reopen failed, retrying')
          if (this.reopenFailures === 3 || this.reopenFailures % 30 === 0) this.emit('problem', `cannot reopen the stream (${this.reopenFailures} tries): ${err.message}`)
          this.scheduleReopen()
        },
      )
    }, delay)
  }

  /** An open stream that delivers nothing (not even ping replies) is dead: replace it. */
  private checkStall(): void {
    const stream = this.stream
    if (this.stopped || !stream || !this.connected) return
    const quietMs = Date.now() - this.lastMessageAt
    if (quietMs < STALL_MS) return
    this.stalls++
    this.log.warn({ quietSec: Math.round(quietMs / 1000) }, 'gRPC stream delivers nothing, reconnecting')
    this.emit('problem', `no data for ${Math.round(quietMs / 1000)}s; reconnecting`)
    this.stream = undefined
    this.connected = false
    this.emit('status', false)
    stream.destroy()
    this.scheduleReopen()
  }

  /** One undecodable transaction must not take the bot down; many of them mean the protocol changed. */
  private decodeFailed(err: unknown): void {
    this.decodeErrors++
    if (this.decodeErrors === 1 || this.decodeErrors % 1_000 === 0) {
      this.log.error({ err, count: this.decodeErrors }, 'could not decode a pump transaction')
      this.emit('problem', `${this.decodeErrors} pump transaction(s) could not be decoded (${(err as Error).message}); did the program change?`)
    }
  }

  private async openDeshred(): Promise<void> {
    try {
      const stream = (await this.client.subscribeDeshred()) as DuplexLike
      this.deshred = stream
      stream.write({
        deshredTransactions: {
          pump: { vote: false, accountInclude: [PUMP_PROGRAM_ID.toBase58()], accountExclude: [], accountRequired: [] },
        },
        slots: {},
      })
      this.deshredBackoff = 500
      this.log.info('gRPC deshred stream connected')
      stream.on('data', (u: { deshredTransaction?: DeshredUpdate }) => {
        if (!u.deshredTransaction) return
        try {
          this.onDeshred(u.deshredTransaction)
        } catch (err) {
          this.decodeFailed(err)
        }
      })
      stream.on('error', (err: Error) => this.log.warn({ err: err.message }, 'deshred stream error'))
      stream.on('close', () => this.scheduleDeshredReconnect())
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'deshred subscription unavailable')
      this.scheduleDeshredReconnect()
    }
  }

  private scheduleDeshredReconnect(): void {
    if (this.stopped) return
    const delay = this.deshredBackoff
    this.deshredBackoff = Math.min(this.deshredBackoff * 2, 30_000)
    setTimeout(() => {
      if (!this.stopped) void this.openDeshred()
    }, delay)
  }

  private ping(): void {
    // Re-sending the same filters with a ping keeps idle-sensitive proxies happy
    // without changing the subscription.
    this.stream?.write({ ...this.txRequest, ping: { id: ++this.pingId } })
  }

  private onTransaction(u: TxUpdate): void {
    const receivedAt = nowMs()
    const info = u.transaction
    if (!info) return
    this.txs++
    const meta = info.meta
    const err = meta?.err ?? null
    let events: PumpEvent[] = []
    if (!err && meta) {
      events = parsePumpLogs(meta.logMessages)
      if (events.length === 0 && meta.innerInstructions.length > 0) events = this.cpiEvents(info.transaction?.message, meta)
    }
    this.emit('tx', {
      signature: bs58.encode(info.signature),
      slot: Number(u.slot),
      err,
      events,
      receivedAt,
      source: this.name,
    } satisfies FeedTx)
  }

  /** Fallback when logs are truncated: decode `emit_cpi!` self-invocations. */
  private cpiEvents(message: TxMessage | undefined, meta: NonNullable<NonNullable<TxUpdate['transaction']>['meta']>): PumpEvent[] {
    if (!message) return []
    const keys = [...message.accountKeys, ...meta.loadedWritableAddresses, ...meta.loadedReadonlyAddresses]
    const out: PumpEvent[] = []
    for (const group of meta.innerInstructions) {
      for (const ix of group.instructions) {
        const program = keys[ix.programIdIndex]
        if (!program || !sameKey(program, PUMP_BYTES)) continue
        const ev = decodeCpiEventInstruction(ix.data)
        if (ev) out.push(ev)
      }
    }
    return out
  }

  private onDeshred(u: DeshredUpdate): void {
    const receivedAt = nowMs()
    const info = u.transaction
    const message = info?.transaction?.message
    if (!info || !message) return
    const keys = [...message.accountKeys, ...info.loadedWritableAddresses, ...info.loadedReadonlyAddresses]

    let create: CreateInstruction | undefined
    const buys: BuyInstruction[] = []
    for (const ix of message.instructions) {
      const program = keys[ix.programIdIndex]
      if (!program || !sameKey(program, PUMP_BYTES)) continue
      // Only materialize PublicKeys for instructions we will actually decode.
      const isCreate = discriminatorEquals(ix.data, IX.createV2) || discriminatorEquals(ix.data, IX.create)
      if (!isCreate && !create) continue
      const accounts = Array.from(ix.accounts, (i) => new PublicKey(keys[i] ?? new Uint8Array(32)))
      const decoded = decodePumpInstruction(ix.data, accounts)
      if (decoded?.kind === 'create') create = decoded
      else if (decoded?.kind === 'buy') buys.push(decoded)
    }
    if (!create) return
    this.emit('preview', {
      signature: bs58.encode(info.signature),
      slot: Number(u.slot),
      create,
      buys: buys.filter((b) => b.mint.equals(create.mint)),
      receivedAt,
    } satisfies LaunchPreview)
  }
}
