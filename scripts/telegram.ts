/**
 * Telegram setup helper.
 *
 *   npm run telegram
 *
 * 1. Create a bot with @BotFather and put its token in .env as TELEGRAM_BOT_TOKEN.
 * 2. Send your bot any message, then run this: it prints your chat id.
 * 3. Put it in .env as TELEGRAM_CHAT_ID and run this again: it sends a test message.
 */
import { config as loadDotenv } from 'dotenv'
import { telegramCall } from '../src/notify/telegram.js'

loadDotenv({ quiet: true })
const token = process.env.TELEGRAM_BOT_TOKEN
const chatId = process.env.TELEGRAM_CHAT_ID
const apiUrl = process.env.TELEGRAM_API_URL ?? 'https://api.telegram.org'

if (!token) {
  console.log('Set TELEGRAM_BOT_TOKEN in .env first. Create a bot by messaging @BotFather on Telegram (/newbot).')
  process.exit(1)
}

try {
  const me = await telegramCall<{ username: string }>({ token, apiUrl }, 'getMe', {})
  console.log(`Bot: @${me.username}`)
  if (!chatId) {
    type Update = { message?: { chat: { id: number; type: string; title?: string; first_name?: string; username?: string } } }
    const updates = await telegramCall<Update[]>({ token, apiUrl }, 'getUpdates', { timeout: 0 })
    const chats = new Map<number, string>()
    for (const u of updates) {
      const c = u.message?.chat
      if (c) chats.set(c.id, c.title ?? c.first_name ?? c.username ?? c.type)
    }
    if (!chats.size) {
      console.log(`No messages yet. Send @${me.username} any message on Telegram, then run this again.`)
      process.exit(1)
    }
    console.log('Put one of these in .env, then run this again to send a test message:')
    for (const [id, name] of chats) console.log(`  TELEGRAM_CHAT_ID=${id}    # ${name}`)
    process.exit(0)
  }
  await telegramCall({ token, apiUrl }, 'sendMessage', { chat_id: chatId, text: '✅ Sol Sniper kan je hier bereiken. Typ /help zodra de bot draait.' })
  console.log('Test message sent. Notifications are on the next time the bot starts.')
} catch (err) {
  console.error(`Telegram: ${(err as Error).message}`)
  process.exit(1)
}
