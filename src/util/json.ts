import { PublicKey } from '@solana/web3.js'

/** JSON replacer for bigint, PublicKey, Set and Map values. */
export function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof PublicKey) return value.toBase58()
  if (value instanceof Set) return [...value]
  if (value instanceof Map) return Object.fromEntries(value)
  if (value instanceof RegExp) return value.source
  return value
}

export const toJson = (value: unknown, space?: number) => JSON.stringify(value, jsonReplacer, space)
