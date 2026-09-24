import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import type { Logger } from '../util/logger.js'

type Handler = (result: unknown, context: { slot?: number }) => void

interface Subscription {
  localId: number
  method: string
  params: unknown[]
  unsubscribeMethod: string
  handler: Handler
  serverId?: number
}

interface RpcMessage {
  id?: number
  result?: unknown
  error?: { code: number; message: string }
  method?: string
  params?: { subscription: number; result: { context?: { slot: number }; value?: unknown } | unknown }
}

export interface WsStats {
  connected: boolean
  reconnects: number
  messages: number
  lastMessageAt: number
  connectedAt: number
}

/**
 * Solana JSON-RPC websocket with automatic reconnect and resubscribe.
 *
 * Compression is disabled (it trades latency for bandwidth) and a ping/pong
 * watchdog replaces silently dead sockets, which otherwise look healthy while
 * delivering nothing.
 */
export class SolanaWs extends EventEmitter {
  private ws?: WebSocket
  private readonly subs = new Map<number, Subscription>()
  private readonly byServerId = new Map<number, Subscription>()
  private readonly pendingSubscribe = new Map<number, Subscription>()
  private nextId = 1
  private backoffMs = 250
  private stopped = true
  private heartbeat?: NodeJS.Timeout
  private awaitingPong = false
  private reconnectTimer?: NodeJS.Timeout

  readonly stats: WsStats = { connected: false, reconnects: 0, messages: 0, lastMessageAt: 0, connectedAt: 0 }

  constructor(
    private readonly url: string,
    private readonly log: Logger,
    private readonly name = 'ws',
  ) {
    super()
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    clearInterval(this.heartbeat)
    clearTimeout(this.reconnectTimer)
    this.ws?.removeAllListeners()
    this.ws?.terminate()
    this.ws = undefined
    this.stats.connected = false
  }

  /**
   * Registers a subscription that survives reconnects.
   * Returns a function that cancels it.
   */
  subscribe(method: string, params: unknown[], unsubscribeMethod: string, handler: Handler): () => void {
    const sub: Subscription = { localId: this.nextId++, method, params, unsubscribeMethod, handler }
    this.subs.set(sub.localId, sub)
    if (this.ws?.readyState === WebSocket.OPEN) this.sendSubscribe(sub)
    return () => this.unsubscribe(sub)
  }

  private unsubscribe(sub: Subscription): void {
    if (!this.subs.delete(sub.localId)) return
    if (sub.serverId !== undefined) {
      this.byServerId.delete(sub.serverId)
      this.send({ jsonrpc: '2.0', id: this.nextId++, method: sub.unsubscribeMethod, params: [sub.serverId] })
    }
  }

  private connect(): void {
    const ws = new WebSocket(this.url, { perMessageDeflate: false, handshakeTimeout: 10_000 })
    this.ws = ws

    ws.on('open', () => {
      this.stats.connected = true
      this.stats.connectedAt = Date.now()
      this.backoffMs = 250
      this.byServerId.clear()
      this.pendingSubscribe.clear()
      for (const sub of this.subs.values()) {
        sub.serverId = undefined
        this.sendSubscribe(sub)
      }
      this.startHeartbeat(ws)
      this.log.info({ ws: this.name, subs: this.subs.size }, 'websocket connected')
      this.emit('open')
    })

    ws.on('message', (raw: WebSocket.RawData) => this.onMessage(raw))
    ws.on('pong', () => {
      this.awaitingPong = false
    })
    ws.on('error', (err) => this.log.warn({ ws: this.name, err: err.message }, 'websocket error'))
    ws.on('close', (code) => {
      clearInterval(this.heartbeat)
      this.stats.connected = false
      if (this.ws === ws) this.ws = undefined
      this.emit('close')
      if (this.stopped) return
      this.stats.reconnects++
      const delay = this.backoffMs
      this.backoffMs = Math.min(this.backoffMs * 2, 5_000)
      this.log.warn({ ws: this.name, code, retryInMs: delay }, 'websocket closed, reconnecting')
      this.reconnectTimer = setTimeout(() => this.connect(), delay)
    })
  }

  private startHeartbeat(ws: WebSocket): void {
    clearInterval(this.heartbeat)
    this.awaitingPong = false
    this.heartbeat = setInterval(() => {
      if (this.awaitingPong) {
        this.log.warn({ ws: this.name }, 'websocket heartbeat missed, terminating')
        ws.terminate()
        return
      }
      this.awaitingPong = true
      ws.ping()
    }, 10_000)
  }

  private sendSubscribe(sub: Subscription): void {
    const id = this.nextId++
    this.pendingSubscribe.set(id, sub)
    this.send({ jsonrpc: '2.0', id, method: sub.method, params: sub.params })
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  private onMessage(raw: WebSocket.RawData): void {
    this.stats.messages++
    this.stats.lastMessageAt = Date.now()
    let msg: RpcMessage
    try {
      msg = JSON.parse(raw.toString()) as RpcMessage
    } catch {
      return
    }

    if (msg.params && typeof msg.params.subscription === 'number') {
      const sub = this.byServerId.get(msg.params.subscription)
      if (!sub) return
      const result = msg.params.result as { context?: { slot: number }; value?: unknown }
      const hasEnvelope = result !== null && typeof result === 'object' && 'value' in result
      try {
        sub.handler(hasEnvelope ? result.value : result, { slot: hasEnvelope ? result.context?.slot : undefined })
      } catch (err) {
        this.log.error({ err, ws: this.name, method: sub.method }, 'subscription handler threw')
      }
      return
    }

    if (msg.id !== undefined) {
      const sub = this.pendingSubscribe.get(msg.id)
      if (!sub) return
      this.pendingSubscribe.delete(msg.id)
      if (msg.error) {
        this.log.error({ ws: this.name, method: sub.method, error: msg.error }, 'subscription rejected')
        return
      }
      if (!this.subs.has(sub.localId)) {
        // Cancelled while the request was in flight.
        this.send({ jsonrpc: '2.0', id: this.nextId++, method: sub.unsubscribeMethod, params: [msg.result] })
        return
      }
      sub.serverId = msg.result as number
      this.byServerId.set(sub.serverId, sub)
    }
  }
}
