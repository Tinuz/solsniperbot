import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { BorshCoder, type Idl } from '@coral-xyz/anchor'
import BN from 'bn.js'

// The official SDK's ESM build trips over a transitive anchor import, so the
// reference implementation is loaded through its CommonJS entry point.
const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const sdk: any = require('@pump-fun/pump-sdk')

export const pumpIdl = JSON.parse(readFileSync(new URL('./fixtures/pump.idl.json', import.meta.url), 'utf8')) as Idl
export const feesIdl = JSON.parse(readFileSync(new URL('./fixtures/pump_fees.idl.json', import.meta.url), 'utf8')) as Idl

/** Anchor coder for the published IDL. Field names must be snake_case. */
export const pumpCoder = new BorshCoder(pumpIdl)
export const feesCoder = new BorshCoder(feesIdl)

export const bn = (v: bigint | number) => new BN(v.toString())
export const big = (v: BN) => BigInt(v.toString())

/**
 * Encodes an account with its discriminator. Anchor's own `accounts.encode`
 * uses a fixed 1000-byte scratch buffer, too small for pump's Global.
 */
export function encodeAccount(coder: BorshCoder, name: string, fields: unknown, minLength = 0): Buffer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layout = (coder.accounts as any).accountLayouts.get(name)
  const buf = Buffer.alloc(Math.max(8192, minLength))
  const len = layout.layout.encode(fields, buf)
  const out = Buffer.concat([Buffer.from(layout.discriminator), buf.subarray(0, len)])
  return out.length >= minLength ? out : Buffer.concat([out, Buffer.alloc(minLength - out.length)])
}

/** Deterministic PRNG so property-style tests are reproducible. */
export function rng(seed = 42) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function randomBig(next: () => number, lo: bigint, hi: bigint): bigint {
  const span = hi - lo
  const r = BigInt(Math.floor(next() * 2 ** 52)) * span / 2n ** 52n
  return lo + r
}
