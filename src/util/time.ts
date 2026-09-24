export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Monotonic milliseconds with sub-ms precision, for latency measurement. */
export const nowMs = () => performance.now()

/** Rejects with `message` if `promise` does not settle within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, message = `timed out after ${ms}ms`): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** Sliding-window event counter (e.g. buys per minute). */
export class RateWindow {
  private stamps: number[] = []

  constructor(private readonly windowMs: number) {}

  count(now = Date.now()): number {
    const cutoff = now - this.windowMs
    while (this.stamps.length && this.stamps[0]! < cutoff) this.stamps.shift()
    return this.stamps.length
  }

  add(now = Date.now()): void {
    this.stamps.push(now)
  }
}
