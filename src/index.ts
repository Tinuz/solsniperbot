import { config as loadDotenv } from 'dotenv'
import { ApiServer } from './api/server.js'
import { loadConfig } from './config.js'
import { Engine } from './engine.js'
import { Reporter } from './notify/reporter.js'
import { loadKeypair } from './solana/wallet.js'
import { DeadError } from './strategy/survival.js'
import { createLogger } from './util/logger.js'
import { EXIT_CONFIG, EXIT_DEAD } from './util/restart-policy.js'

loadDotenv({ quiet: true })

async function main(): Promise<void> {
  let cfg
  try {
    cfg = loadConfig()
  } catch (e) {
    console.error((e as Error).message)
    console.error('\nCopy .env.example to .env and fill in at least RPC_URL.')
    process.exit(EXIT_CONFIG)
  }
  const log = createLogger(cfg.logLevel)
  let wallet
  try {
    wallet = loadKeypair(cfg)
  } catch (e) {
    console.error(`Wallet: ${(e as Error).message}`)
    process.exit(EXIT_CONFIG)
  }
  const engine = new Engine(cfg, wallet, log)
  const api = new ApiServer(engine, log)
  const reporter = new Reporter(engine, log)

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
      await reporter.stop(signal)
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
    // Non-zero, so a supervisor restarts it (exit 0 means "stopped on purpose").
    void shutdown('uncaughtException', 1)
  })

  try {
    await engine.start()
  } catch (err) {
    if (err instanceof DeadError) {
      log.fatal(err.message)
      await engine.stop().catch(() => undefined)
      await reporter.sendNow(`💀 refuses to start: ${err.message}`)
      process.exit(EXIT_DEAD)
    }
    await reporter.sendNow(`❌ failed to start: ${(err as Error).message}`)
    throw err
  }
  await api.start()
  await reporter.start()
  if (reporter.enabled) log.info('telegram notifications on')
  // Under `npm run supervise`: prove the event loop is alive, so a hung
  // process gets restarted.
  if (process.send) {
    const beat = () => process.send?.({ type: 'heartbeat', at: Date.now() })
    beat()
    setInterval(beat, 10_000).unref()
  }
}

main().catch((err) => {
  console.error('fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
