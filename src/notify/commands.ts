import type { Logger } from '../util/logger.js'
import { sleep } from '../util/time.js'
import { type TelegramTarget, telegramCall } from './telegram.js'

export interface Command {
  /** Lower case, without the slash or a `@botname` suffix. */
  name: string
  args: string
}

export interface CommandHandlers {
  command(c: Command): Promise<void> | void
  /** A tapped button; the returned text shows briefly on the phone. */
  button(data: string): Promise<string | undefined> | string | undefined
}

interface Update {
  update_id: number
  message?: { date: number; text?: string; chat: { id: number | string } }
  callback_query?: { id: string; data?: string; message?: { chat: { id: number | string } } }
}

/** Seconds Telegram holds a getUpdates request open when there is nothing new. */
const POLL_S = 50
/** Commands older than this when the bot sees them (sent while it was down) are ignored. */
const STALE_MS = 60_000

/** The menu Telegram shows when you type "/". */
export const COMMAND_MENU = [
  { command: 'status', description: 'Hoe staat de bot ervoor' },
  { command: 'vandaag', description: 'Trades en resultaat van vandaag' },
  { command: 'posities', description: 'Open posities en moonbags' },
  { command: 'pauze', description: 'Stop met kopen (posities blijven beheerd)' },
  { command: 'hervat', description: 'Hervat het kopen' },
  { command: 'verkoopalles', description: 'Verkoop alle posities (met bevestiging)' },
  { command: 'help', description: 'Uitleg van de commando’s' },
]

/**
 * Listens for commands from the owner's chat (long polling, no open port).
 * Messages from any other chat are ignored, and so are commands that were
 * sent while the bot was down: a /verkoopalles from hours ago must not fire.
 */
export class TelegramCommands {
  private offset?: number
  private stopped = false
  private readonly abort = new AbortController()
  private loop?: Promise<void>
  private readonly startedAt: number

  constructor(
    private readonly target: TelegramTarget,
    private readonly handlers: CommandHandlers,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now()
  }

  start(): void {
    void telegramCall(this.target, 'setMyCommands', { commands: COMMAND_MENU }).catch((err: Error) =>
      this.log.debug({ err: err.message }, 'telegram: could not set the command menu'),
    )
    this.loop = this.run()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.abort.abort()
    await this.loop
  }

  private async run(): Promise<void> {
    let failures = 0
    while (!this.stopped) {
      try {
        const updates = await telegramCall<Update[]>(
          this.target,
          'getUpdates',
          { offset: this.offset, timeout: POLL_S, allowed_updates: ['message', 'callback_query'] },
          { timeoutMs: (POLL_S + 15) * 1000, signal: this.abort.signal },
        )
        failures = 0
        for (const u of Array.isArray(updates) ? updates : []) {
          this.offset = u.update_id + 1
          await this.dispatch(u).catch((err: Error) => this.log.warn({ err: err.message }, 'telegram command failed'))
        }
      } catch (err) {
        if (this.stopped) break
        failures++
        // 409: something else reads this bot's updates (a second bot, `npm run telegram`, a webhook).
        if (failures === 1 || failures % 20 === 0) this.log.warn({ err: (err as Error).message }, 'telegram: cannot read commands, retrying')
        await Promise.race([sleep(Math.min(60_000, 2_000 * 2 ** Math.min(failures, 5))), new Promise((r) => this.abort.signal.addEventListener('abort', r))])
      }
    }
  }

  private ours(chatId: number | string | undefined): boolean {
    return chatId !== undefined && String(chatId) === this.target.chatId
  }

  private async dispatch(u: Update): Promise<void> {
    if (u.message) {
      const m = u.message
      if (!this.ours(m.chat.id) || !m.text?.startsWith('/')) return
      if (m.date * 1000 < this.startedAt - STALE_MS) return
      const [head = '', ...rest] = m.text.trim().split(/\s+/)
      const name = head.slice(1).split('@')[0]!.toLowerCase()
      await this.handlers.command({ name, args: rest.join(' ') })
      return
    }
    const q = u.callback_query
    if (!q) return
    const text = this.ours(q.message?.chat.id) && q.data ? await this.handlers.button(q.data) : undefined
    await telegramCall(this.target, 'answerCallbackQuery', { callback_query_id: q.id, ...(text ? { text } : {}) }).catch(() => undefined)
  }
}
