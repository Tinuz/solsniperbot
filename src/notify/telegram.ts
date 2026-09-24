import type { Logger } from '../util/logger.js'
import { sleep } from '../util/time.js'

export interface TelegramTarget {
  token: string
  chatId: string
  apiUrl: string
}

/** Telegram allows about one message per second per chat. */
const MIN_GAP_MS = 1_100
const MAX_QUEUE = 50
const TIMEOUT_MS = 10_000

/** Calls a Bot API method. Throws with Telegram's own description on failure. */
export async function telegramCall<T>(t: Pick<TelegramTarget, 'token' | 'apiUrl'>, method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${t.apiUrl.replace(/\/$/, '')}/bot${t.token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number } }
  if (!data.ok) {
    const err = new Error(data.description ?? `HTTP ${res.status}`) as Error & { retryAfter?: number }
    err.retryAfter = data.parameters?.retry_after
    throw err
  }
  return data.result as T
}

/**
 * Sends the bot's messages to a Telegram chat. Fire-and-forget: messages
 * queue up and go out one by one within Telegram's rate limit, so a slow or
 * failing Telegram never delays trading.
 */
export class TelegramNotifier {
  private readonly queue: string[] = []
  private draining?: Promise<void>
  private lastSentAt = 0
  sent = 0
  failed = 0

  constructor(
    private readonly target: TelegramTarget,
    private readonly log: Logger,
    /** Put in front of every message, e.g. "[PAPER]". */
    private readonly tag = '',
  ) {}

  send(text: string): void {
    this.queue.push(this.tag ? `${this.tag} ${text}` : text)
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE)
    this.draining ??= this.drain().finally(() => {
      this.draining = undefined
    })
  }

  /** Waits (bounded) until queued messages are out, e.g. before exiting. */
  async flush(timeoutMs = 8_000): Promise<void> {
    if (!this.draining) return
    await Promise.race([this.draining, sleep(timeoutMs)])
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const wait = this.lastSentAt + MIN_GAP_MS - Date.now()
      if (wait > 0) await sleep(wait)
      const text = this.queue[0]!
      try {
        await telegramCall(this.target, 'sendMessage', { chat_id: this.target.chatId, text, disable_web_page_preview: true })
        this.queue.shift()
        this.sent++
      } catch (err) {
        const retryAfter = (err as { retryAfter?: number }).retryAfter
        if (retryAfter !== undefined && retryAfter <= 60) {
          await sleep(retryAfter * 1000)
          continue
        }
        this.queue.shift()
        this.failed++
        this.log.warn({ err: (err as Error).message }, 'telegram message not sent')
      } finally {
        this.lastSentAt = Date.now()
      }
    }
  }
}
