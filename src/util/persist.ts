import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { toJson } from './json.js'

export interface WriteOptions {
  /**
   * For large snapshots of plain data (numbers, strings, arrays, objects: no
   * bigints, keys, sets or maps): no replacer and no indentation, several
   * times faster, so the trading thread barely notices the save.
   */
  compact?: boolean
}

let tmpSeq = 0
/** Writes still in progress per path: the next write to a path starts after the previous one finished. */
const writing = new Map<string, Promise<void>>()

/**
 * Writes JSON atomically (temp file + rename) so a crash never leaves a torn
 * file. Writes to the same path are serialized, and every write has its own
 * temp file, so concurrent callers can never interleave.
 */
export function writeJsonAtomic(path: string, value: unknown, opts: WriteOptions = {}): Promise<void> {
  // Serialize now: the snapshot is what the caller holds at this moment.
  const json = opts.compact ? JSON.stringify(value) : toJson(value, 2)
  const prev = writing.get(path) ?? Promise.resolve()
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      await mkdir(dirname(path), { recursive: true })
      const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`
      await writeFile(tmp, json)
      await rename(tmp, path)
    })
  writing.set(path, next)
  void next.finally(() => {
    if (writing.get(path) === next) writing.delete(path)
  }).catch(() => undefined)
  return next
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
}

/** Append-only JSON-lines journal. Writes are serialized to keep lines intact. */
export class Journal {
  private chain: Promise<void> = Promise.resolve()
  private ready: Promise<unknown>

  constructor(
    private readonly path: string,
    private readonly onError: (err: unknown) => void = () => {},
  ) {
    this.ready = mkdir(dirname(path), { recursive: true })
  }

  append(record: unknown): Promise<void> {
    const line = `${toJson(record)}\n`
    this.chain = this.chain
      .then(() => this.ready)
      .then(() => appendFile(this.path, line))
      .catch(this.onError)
    return this.chain
  }

  flush(): Promise<void> {
    return this.chain
  }
}

/**
 * Coalesces frequent saves: at most one write in flight, and at most one
 * pending after it, always with the latest snapshot.
 */
export class DebouncedWriter {
  private timer: NodeJS.Timeout | undefined
  private inFlight: Promise<void> = Promise.resolve()
  private closed = false

  constructor(
    private readonly path: string,
    private readonly snapshot: () => unknown,
    private readonly delayMs = 250,
    private readonly onError: (err: unknown) => void = () => {},
    private readonly opts: WriteOptions = {},
  ) {}

  schedule(): void {
    if (this.timer || this.closed) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, this.delayMs)
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.closed) return this.inFlight
    this.inFlight = this.inFlight.then(() => writeJsonAtomic(this.path, this.snapshot(), this.opts)).catch(this.onError)
    return this.inFlight
  }

  /** Final write; nothing is written after it (a late change cannot overwrite the last snapshot). */
  async close(): Promise<void> {
    await this.flush()
    this.closed = true
  }
}
