import { config as loadDotenv } from 'dotenv'
import { ApiServer } from './api/server.js'
import { loadConfig } from './config.js'
import { Engine } from './engine.js'
import { loadKeypair } from './solana/wallet.js'
import { DeadError } from './strategy/survival.js'
import { createLogger } from './util/logger.js'

loadDotenv({ quiet: true })

/** Exit code when the bot shuts itself down for lack of funds. Process managers should not restart on it. */
const EXIT_DEAD = 3

async function main(): Promise<void> {
  let cfg
  try {
    cfg = loadConfig()
  } catch (e) {
    console.error((e as Error).message)
    console.error('\nCopy .env.example to .env and fill in at least RPC_URL.')
    process.exit(1)
  }
  const log = createLogger(cfg.logLevel)
  const wallet = loadKeypair(cfg)
  const engine = new Engine(cfg, wallet, log)
  const api = new ApiServer(engine, log)

  let stopping = false
  const shutdown = async (signal: string, code = 0) => {
    if (stopping) {
      log.warn('forced exit')
      process.exit(1)
    }
    stopping = true
    const open = engine.positions.openCount
    log.info({ signal, openPositions: open }, 'shutting down (press Ctrl-C again to force)')
    if (open > 0) log.warn('open positions are saved and will resume monitoring on the next start')
    try {
      await api.stop()
      await engine.stop()
    } catch (err) {
      log.error({ err }, 'error during shutdown')
    }
    process.exit(code)
  }
  engine.on('dead', (v) => {
    if (!cfg.survival.shutdown) {
      log.error('bot is dead; buying stays disabled (SURVIVAL_SHUTDOWN=false keeps the process running)')
      return
    }
    log.fatal({ reason: v.reason }, 'shutting down: the bot can no longer fund a viable trade')
    void shutdown('dead', EXIT_DEAD)
  })
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('unhandledRejection', (err) => log.error({ err }, 'unhandled rejection'))
  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'uncaught exception')
    void shutdown('uncaughtException')
  })

  try {
    await engine.start()
  } catch (err) {
    if (err instanceof DeadError) {
      log.fatal(err.message)
      await engine.stop().catch(() => undefined)
      process.exit(EXIT_DEAD)
    }
    throw err
  }
  await api.start()
}

main().catch((err) => {
  console.error('fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
