/**
 * Keeps the bot running unattended (`npm run supervise`).
 *
 * Restarts it after a crash, or when it stops responding, with growing
 * delays. Never restarts after a deliberate stop (Ctrl-C, exit 0) or after
 * the bot declared itself dead (exit 3): a bot that cannot fund a trade must
 * stay down until it is topped up.
 */
import { type ChildProcess, fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { type RestartState, decideRestart } from './util/restart-policy.js'

/** No heartbeat for this long means the bot hangs. */
const HANG_MS = 90_000
/** Time a starting bot gets before heartbeats are expected. */
const STARTUP_GRACE_MS = 180_000
/** After a stop request, how long the bot gets to save its state. */
const STOP_GRACE_MS = 30_000

const log = (message: string) => console.log(`[supervisor ${new Date().toISOString()}] ${message}`)

function supervise(entry: string, argv: string[]): void {
  let child: ChildProcess | undefined
  let state: RestartState = { crashes: 0 }
  let restarts = 0
  let stopRequested = false
  let startedAt = 0
  let lastBeat = 0
  let hung = false
  let restartTimer: NodeJS.Timeout | undefined

  const start = () => {
    startedAt = Date.now()
    lastBeat = 0
    hung = false
    child = fork(entry, argv, { env: { ...process.env, SUPERVISOR_RESTARTS: String(restarts) } })
    log(`bot started (pid ${child.pid}${restarts ? `, restart #${restarts}` : ''})`)
    child.on('message', (m: { type?: string }) => {
      if (m?.type === 'heartbeat') lastBeat = Date.now()
    })
    child.on('exit', (code, signal) => {
      child = undefined
      const decision = decideRestart({ code, signal, uptimeMs: Date.now() - startedAt, hung, stopRequested }, state)
      state = decision.state
      if (!decision.restart) {
        log(`not restarting: ${decision.reason}`)
        process.exit(stopRequested ? 0 : (code ?? 1))
      }
      restarts++
      log(`${decision.reason}; restarting in ${Math.round(decision.delayMs / 1000)}s`)
      restartTimer = setTimeout(start, decision.delayMs)
    })
  }

  // A hung event loop sends no heartbeats; kill it so it restarts.
  setInterval(() => {
    if (!child || stopRequested) return
    const since = lastBeat || startedAt
    const limit = lastBeat ? HANG_MS : STARTUP_GRACE_MS
    if (Date.now() - since > limit) {
      hung = true
      log(`no heartbeat for ${Math.round((Date.now() - since) / 1000)}s: killing the bot`)
      child.kill('SIGKILL')
    }
  }, 5_000).unref()

  const stop = (signal: NodeJS.Signals) => {
    if (stopRequested) return
    stopRequested = true
    clearTimeout(restartTimer)
    if (!child) process.exit(0)
    log(`${signal}: waiting for the bot to save its state`)
    // In a terminal the bot receives Ctrl-C itself; only forward when it didn't.
    const current = child
    setTimeout(() => current.exitCode === null && current.kill('SIGTERM'), 3_000).unref()
    setTimeout(() => current.exitCode === null && current.kill('SIGKILL'), STOP_GRACE_MS).unref()
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))

  start()
}

// Under tsx the child inherits the loader through execArgv, so both work.
const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js'
supervise(fileURLToPath(new URL(`./index.${ext}`, import.meta.url)), process.argv.slice(2))
