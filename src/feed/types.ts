import type { EventEmitter } from 'node:events'
import type { PublicKey } from '@solana/web3.js'
import type { BuyInstruction, CreateInstruction, PumpEvent } from '../pump/events.js'

export type FeedSource = 'ws' | 'grpc' | 'deshred'

/** One executed pump transaction, as delivered by a feed at `processed`. */
export interface FeedTx {
  signature: string
  slot: number
  /** Non-null when the transaction failed; its events were rolled back. */
  err: unknown
  events: PumpEvent[]
  /** `performance.now()` when the notification arrived. */
  receivedAt: number
  source: FeedSource
}

/** A create transaction seen in shreds, before it has executed. */
export interface LaunchPreview {
  signature: string
  slot: number
  create: CreateInstruction
  buys: BuyInstruction[]
  receivedAt: number
}

export interface FeedStats {
  source: FeedSource
  connected: boolean
  txs: number
  reconnects: number
  lastMessageAt: number
}

export interface Feed extends EventEmitter {
  readonly name: FeedSource
  start(): Promise<void>
  stop(): void
  stats(): FeedStats
  on(event: 'tx', listener: (tx: FeedTx) => void): this
  on(event: 'preview', listener: (p: LaunchPreview) => void): this
  on(event: 'status', listener: (connected: boolean) => void): this
}

export const mintKey = (k: PublicKey) => k.toBase58()
