import { readFileSync } from 'node:fs'
import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'

function fromSecret(secret: Uint8Array): Keypair {
  if (secret.length !== 64) throw new Error(`secret key must be 64 bytes, got ${secret.length}`)
  return Keypair.fromSecretKey(secret)
}

function parseSecret(raw: string): Uint8Array {
  const s = raw.trim()
  if (s.startsWith('[')) return Uint8Array.from(JSON.parse(s) as number[])
  return bs58.decode(s)
}

/**
 * Loads the trading keypair from PRIVATE_KEY (base58 or JSON byte array) or a
 * solana-keygen JSON file. Returns undefined when neither is configured.
 */
export function loadKeypair(opts: { privateKey?: string; keypairPath?: string }): Keypair | undefined {
  if (opts.privateKey) {
    try {
      return fromSecret(parseSecret(opts.privateKey))
    } catch (e) {
      // Never echo the key material itself.
      throw new Error(`PRIVATE_KEY could not be parsed: ${(e as Error).message}`)
    }
  }
  if (opts.keypairPath) {
    return fromSecret(parseSecret(readFileSync(opts.keypairPath, 'utf8')))
  }
  return undefined
}
