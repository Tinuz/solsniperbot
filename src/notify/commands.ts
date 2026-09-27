import { setTimeout as delay } from 'node:timers/promises'
import type { Logger } from '../util/logger.js'
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
  message?: { date: number; text?: string; chat: { id: number | string }; from?: { id: number } }
  callback_query?: { id: string; data?: string; from?: { id: number }; message?: { chat: { id: number | string } } }
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
 * Listens for commands from the owner (long polling, no open port). A
 * command or button counts only from the owner's chat *and* from the owner:
 * a user in TELEGRAM_OWNER_IDS, or without that setting, the private chat's
 * own user (in a private chat the chat id is the user's id). In a group,
 * other members can read along but never pause or sell. Commands sent while
 * the bot was down are ignored too: a /verkoopalles from hours ago must not
 * fire.
 */
export class TelegramCommands {
  private offset?: number
  private stopped = false
  private readonly abort = new AbortController()
  private loop?: Promise<void>
  private readonly startedAt: number
  private warnedGroup = false

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
        await delay(Math.min(60_000, 2_000 * 2 ** Math.min(failures, 5)), undefined, { signal: this.abort.signal }).catch(() => undefined)
      }
    }
  }

  /** From the owner, in the owner's chat. */
  private allowed(chatId: number | string | undefined, userId: number | undefined): boolean {
    if (chatId === undefined || userId === undefined || String(chatId) !== this.target.chatId) return false
    const owners = this.target.ownerIds ?? []
    if (owners.length) return owners.includes(String(userId))
    if (String(userId) === String(chatId)) return true
    if (!this.warnedGroup) {
      this.warnedGroup = true
      this.log.warn('telegram: commands in a group chat are ignored until TELEGRAM_OWNER_IDS lists who may give them')
    }
    return false
  }

  private async dispatch(u: Update): Promise<void> {
    if (u.message) {
      const m = u.message
      if (!m.text?.startsWith('/') || !this.allowed(m.chat.id, m.from?.id)) return
      if (m.date * 1000 < this.startedAt - STALE_MS) return
      const [head = '', ...rest] = m.text.trim().split(/\s+/)
      const name = head.slice(1).split('@')[0]!.toLowerCase()
      await this.handlers.command({ name, args: rest.join(' ') })
      return
    }
    const q = u.callback_query
    if (!q) return
    const text = this.allowed(q.message?.chat.id, q.from?.id) && q.data ? await this.handlers.button(q.data) : undefined
    await telegramCall(this.target, 'answerCallbackQuery', { callback_query_id: q.id, ...(text ? { text } : {}) }).catch(() => undefined)
  }
}
