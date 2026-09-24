/** Map-backed LRU cache. `get` refreshes recency; the oldest entry is evicted on overflow. */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>()

  constructor(private readonly capacity: number) {
    if (capacity < 1) throw new Error('LRU capacity must be >= 1')
  }

  get size(): number {
    return this.map.size
  }

  get(key: K): V | undefined {
    const value = this.map.get(key)
    if (value === undefined) return undefined
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  /** Reads without touching recency. */
  peek(key: K): V | undefined {
    return this.map.get(key)
  }

  has(key: K): boolean {
    return this.map.has(key)
  }

  set(key: K, value: V): this {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next()
      if (!oldest.done) this.map.delete(oldest.value)
    }
    return this
  }

  delete(key: K): boolean {
    return this.map.delete(key)
  }

  getOrCreate(key: K, create: () => V): V {
    const hit = this.get(key)
    if (hit !== undefined) return hit
    const value = create()
    this.set(key, value)
    return value
  }

  values(): IterableIterator<V> {
    return this.map.values()
  }

  entries(): IterableIterator<[K, V]> {
    return this.map.entries()
  }
}
