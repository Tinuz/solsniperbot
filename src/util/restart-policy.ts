/** Exit code the bot uses when it shuts itself down for lack of funds. */
export const EXIT_DEAD = 3
/** Exit code for a configuration the bot cannot run with (sysexits EX_CONFIG). */
export const EXIT_CONFIG = 78

export interface RestartState {
  /** Crashes in a row without a stable run in between. */
  crashes: number
}

export interface RestartDecision {
  restart: boolean
  delayMs: number
  reason: string
  state: RestartState
}

export const RESTART_LIMITS = {
  /** A run this long counts as stable and resets the backoff. */
  stableMs: 10 * 60_000,
  baseDelayMs: 5_000,
  maxDelayMs: 5 * 60_000,
}

/**
 * What to do when the bot process ends. Restart after crashes and hangs,
 * with growing delays and without ever giving up (a network outage can
 * last a while); never after a deliberate stop (exit 0 or a stop request),
 * a configuration error (exit 78), or the bot declaring itself dead (exit 3).
 */
export function decideRestart(
  exit: { code: number | null; signal: string | null; uptimeMs: number; hung?: boolean; stopRequested?: boolean },
  prev: RestartState,
  limits = RESTART_LIMITS,
): RestartDecision {
  const stop = (reason: string): RestartDecision => ({ restart: false, delayMs: 0, reason, state: prev })
  if (exit.stopRequested) return stop('stopped on request')
  if (!exit.hung && exit.code === 0) return stop('the bot stopped cleanly')
  if (!exit.hung && exit.code === EXIT_DEAD) return stop('the bot shut itself down: it can no longer fund a viable trade')
  if (!exit.hung && exit.code === EXIT_CONFIG) return stop('configuration error: fix .env (see the message above) and start again')
  const state: RestartState = { crashes: exit.uptimeMs >= limits.stableMs ? 1 : prev.crashes + 1 }
  const delayMs = Math.min(limits.baseDelayMs * 2 ** (state.crashes - 1), limits.maxDelayMs)
  return { restart: true, delayMs, reason: `the bot ${exit.hung ? 'stopped responding' : `exited with ${exit.signal ?? `code ${exit.code}`}`}`, state }
}
