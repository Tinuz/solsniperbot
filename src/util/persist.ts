import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { toJson } from './json.js'

/** Writes JSON atomically (temp file + rename) so a crash never leaves a torn file. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, toJson(value, 2))
  await rename(tmp, path)
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

  constructor(
    private readonly path: string,
    private readonly snapshot: () => unknown,
    private readonly delayMs = 250,
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  schedule(): void {
    if (this.timer) return
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
    this.inFlight = this.inFlight.then(() => writeJsonAtomic(this.path, this.snapshot())).catch(this.onError)
    return this.inFlight
  }
}
