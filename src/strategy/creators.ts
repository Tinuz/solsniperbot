import { join } from 'node:path'
import type { Logger } from '../util/logger.js'
import { LruCache } from '../util/lru.js'
import { DebouncedWriter, readJson } from '../util/persist.js'

type Snapshot = Record<string, number[]>

/**
 * Launch history per dev wallet, learned from the live stream and persisted
 * across restarts. Wallets that launch coin after coin are the classic
 * pump-and-rug farm; counting them costs nothing at decision time.
 */
export class CreatorReputation {
  private readonly launches = new LruCache<string, number[]>(100_000)
  private readonly writer: DebouncedWriter
  private readonly path: string

  constructor(
    dataDir: string,
    private readonly windowMs: number,
    private readonly log: Logger,
  ) {
    this.path = join(dataDir, 'creators.json')
    this.writer = new DebouncedWriter(
      this.path,
      () => this.snapshot(),
      60_000,
      (err) => this.log.warn({ err }, 'failed to persist creator history'),
      { compact: true },
    )
  }

  async load(): Promise<void> {
    const data = await readJson<Snapshot>(this.path)
    if (!data) return
    const cutoff = Date.now() - this.windowMs
    for (const [dev, stamps] of Object.entries(data)) {
      const recent = stamps.filter((t) => t >= cutoff)
      if (recent.length) this.launches.set(dev, recent)
    }
    this.log.info({ wallets: this.launches.size }, 'loaded creator history')
  }

  /** Records a launch and returns how many launches the wallet has in the window. */
  record(dev: string, at = Date.now()): number {
    const cutoff = at - this.windowMs
    const stamps = (this.launches.get(dev) ?? []).filter((t) => t >= cutoff)
    stamps.push(at)
    this.launches.set(dev, stamps)
    this.writer.schedule()
    return stamps.length
  }

  count(dev: string, at = Date.now()): number {
    const cutoff = at - this.windowMs
    return (this.launches.peek(dev) ?? []).filter((t) => t >= cutoff).length
  }

  flush(): Promise<void> {
    return this.writer.flush()
  }

  private snapshot(): Snapshot {
    const cutoff = Date.now() - this.windowMs
    const out: Snapshot = {}
    for (const [dev, stamps] of this.launches.entries()) {
      const recent = stamps.filter((t) => t >= cutoff)
      if (recent.length) out[dev] = recent
    }
    return out
  }
}
