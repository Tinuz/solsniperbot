import { getText } from '../solana/http.js'
import { LruCache } from '../util/lru.js'

export interface TokenMetadata {
  name?: string
  symbol?: string
  description?: string
  image?: string
  twitter?: string
  telegram?: string
  website?: string
}

const IPFS_GATEWAY = process.env.IPFS_GATEWAY ?? 'https://ipfs.io/ipfs/'

export function resolveUri(uri: string): string {
  if (uri.startsWith('ipfs://')) return IPFS_GATEWAY + uri.slice('ipfs://'.length).replace(/^ipfs\//, '')
  return uri
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)

export function hasSocials(m: TokenMetadata | undefined): boolean {
  return Boolean(m && (m.twitter || m.telegram || m.website))
}

/**
 * Fetches off-chain token metadata (name, image, socials). This is the only
 * filter input that needs network I/O, so it runs under a hard deadline and
 * results are cached.
 */
export class MetadataFetcher {
  private readonly cache = new LruCache<string, Promise<TokenMetadata | undefined>>(5_000)

  fetch(uri: string, timeoutMs: number): Promise<TokenMetadata | undefined> {
    if (!/^(https?|ipfs):\/\//i.test(uri)) return Promise.resolve(undefined)
    return this.cache.getOrCreate(uri, () =>
      getText(resolveUri(uri), { timeoutMs, maxBytes: 64 * 1024 })
        .then((text) => {
          const j = JSON.parse(text) as Record<string, unknown>
          const ext = (j.extensions ?? {}) as Record<string, unknown>
          return {
            name: str(j.name),
            symbol: str(j.symbol),
            description: str(j.description),
            image: str(j.image),
            twitter: str(j.twitter) ?? str(ext.twitter),
            telegram: str(j.telegram) ?? str(ext.telegram),
            website: str(j.website) ?? str(ext.website),
          }
        })
        .catch(() => {
          // Let a later attempt retry instead of caching the failure.
          this.cache.delete(uri)
          return undefined
        }),
    )
  }
}
