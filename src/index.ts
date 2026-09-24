import { config as loadDotenv } from 'dotenv'
import { ApiServer } from './api/server.js'
import { loadConfig } from './config.js'
import { Engine } from './engine.js'
import { loadKeypair } from './solana/wallet.js'
import { createLogger } from './util/logger.js'

loadDotenv({ quiet: true })

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
  const shutdown = async (signal: string) => {
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
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('unhandledRejection', (err) => log.error({ err }, 'unhandled rejection'))
  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'uncaught exception')
    void shutdown('uncaughtException')
  })

  await engine.start()
  await api.start()
}

main().catch((err) => {
  console.error('fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
