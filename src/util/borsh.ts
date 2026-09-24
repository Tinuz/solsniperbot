import { PublicKey } from '@solana/web3.js'

const ZERO_KEY = new Uint8Array(32)

/**
 * Minimal forward-only Borsh reader.
 *
 * Reads past the end of the buffer return zero values instead of throwing.
 * pump.fun keeps appending fields to its accounts and events, and older
 * accounts/logs are shorter; the program itself treats missing trailing fields
 * as zero/false, so this mirrors on-chain behaviour.
 */
export class BorshReader {
  private readonly view: DataView
  offset: number

  constructor(private readonly buf: Uint8Array, offset = 0) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    this.offset = offset
  }

  get length(): number {
    return this.buf.length
  }

  get exhausted(): boolean {
    return this.offset >= this.buf.length
  }

  private has(n: number): boolean {
    return this.offset + n <= this.buf.length
  }

  skip(n: number): void {
    this.offset += n
  }

  u8(): number {
    const v = this.has(1) ? this.view.getUint8(this.offset) : 0
    this.offset += 1
    return v
  }

  bool(): boolean {
    return this.u8() !== 0
  }

  u16(): number {
    const v = this.has(2) ? this.view.getUint16(this.offset, true) : 0
    this.offset += 2
    return v
  }

  u32(): number {
    const v = this.has(4) ? this.view.getUint32(this.offset, true) : 0
    this.offset += 4
    return v
  }

  u64(): bigint {
    const v = this.has(8) ? this.view.getBigUint64(this.offset, true) : 0n
    this.offset += 8
    return v
  }

  i64(): bigint {
    const v = this.has(8) ? this.view.getBigInt64(this.offset, true) : 0n
    this.offset += 8
    return v
  }

  u128(): bigint {
    const lo = this.u64()
    const hi = this.u64()
    return (hi << 64n) | lo
  }

  pubkeyBytes(): Uint8Array {
    const v = this.has(32) ? this.buf.subarray(this.offset, this.offset + 32) : ZERO_KEY
    this.offset += 32
    return v
  }

  pubkey(): PublicKey {
    return new PublicKey(this.pubkeyBytes())
  }

  string(): string {
    const len = this.u32()
    if (len === 0 || !this.has(len)) {
      this.offset += len
      return ''
    }
    const s = Buffer.from(this.buf.buffer, this.buf.byteOffset + this.offset, len).toString('utf8')
    this.offset += len
    return s
  }

  /** Reads a Borsh `Vec<T>` whose elements have a fixed size. */
  vec<T>(read: (r: BorshReader) => T, maxLen = 1024): T[] {
    const len = this.u32()
    if (len > maxLen) throw new Error(`borsh vec length ${len} exceeds limit ${maxLen}`)
    const out: T[] = []
    for (let i = 0; i < len && !this.exhausted; i++) out.push(read(this))
    return out
  }
}

export function discriminatorEquals(data: Uint8Array, disc: Uint8Array, offset = 0): boolean {
  if (data.length < offset + 8) return false
  for (let i = 0; i < 8; i++) if (data[offset + i] !== disc[i]) return false
  return true
}

/** Encodes `disc || u64 || u64`, the layout of every pump trade instruction. */
export function encodeU64Pair(disc: Uint8Array, a: bigint, b: bigint): Buffer {
  const out = Buffer.alloc(24)
  out.set(disc, 0)
  out.writeBigUInt64LE(a, 8)
  out.writeBigUInt64LE(b, 16)
  return out
}
