import { PublicKey } from '@solana/web3.js'
import { postJson } from './http.js'

export type Commitment = 'processed' | 'confirmed' | 'finalized'

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(`RPC ${code}: ${message}`)
  }
}

export interface AccountData {
  data: Buffer
  owner: PublicKey
  lamports: number
  executable: boolean
}

export interface SignatureStatus {
  slot: number
  confirmationStatus: Commitment | null
  err: unknown
}

export interface SimulationResult {
  err: unknown
  logs: string[]
  unitsConsumed?: number
}

interface RawAccount {
  data: [string, string]
  owner: string
  lamports: number
  executable: boolean
}

const toAccount = (raw: RawAccount | null): AccountData | null =>
  raw
    ? {
        data: Buffer.from(raw.data[0], 'base64'),
        owner: new PublicKey(raw.owner),
        lamports: raw.lamports,
        executable: raw.executable,
      }
    : null

/**
 * Thin JSON-RPC client. Only the methods the bot needs, no retries hidden
 * inside: callers decide whether a failure is worth retrying.
 */
export class RpcClient {
  private id = 0

  constructor(
    readonly url: string,
    private readonly defaultTimeoutMs = 8_000,
  ) {}

  async call<T>(method: string, params: unknown[] = [], timeoutMs = this.defaultTimeoutMs): Promise<T> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params })
    const res = await postJson<{ result?: T; error?: { code: number; message: string; data?: unknown } }>(
      this.url,
      body,
      { timeoutMs },
    )
    if (res.error) throw new RpcError(res.error.code, res.error.message, res.error.data)
    return res.result as T
  }

  async getLatestBlockhash(commitment: Commitment = 'confirmed') {
    const r = await this.call<{ context: { slot: number }; value: { blockhash: string; lastValidBlockHeight: number } }>(
      'getLatestBlockhash',
      [{ commitment }],
      3_000,
    )
    return { blockhash: r.value.blockhash, lastValidBlockHeight: r.value.lastValidBlockHeight, slot: r.context.slot }
  }

  getSlot(commitment: Commitment = 'processed') {
    return this.call<number>('getSlot', [{ commitment }], 3_000)
  }

  getBlockHeight(commitment: Commitment = 'confirmed') {
    return this.call<number>('getBlockHeight', [{ commitment }], 3_000)
  }

  async getBalance(key: PublicKey, commitment: Commitment = 'confirmed'): Promise<bigint> {
    const r = await this.call<{ value: number }>('getBalance', [key.toBase58(), { commitment }])
    return BigInt(r.value)
  }

  async getAccountInfo(key: PublicKey, commitment: Commitment = 'confirmed'): Promise<AccountData | null> {
    const r = await this.call<{ value: RawAccount | null }>('getAccountInfo', [
      key.toBase58(),
      { encoding: 'base64', commitment },
    ])
    return toAccount(r.value)
  }

  async getMultipleAccounts(keys: PublicKey[], commitment: Commitment = 'confirmed'): Promise<(AccountData | null)[]> {
    if (keys.length === 0) return []
    const r = await this.call<{ value: (RawAccount | null)[] }>('getMultipleAccounts', [
      keys.map((k) => k.toBase58()),
      { encoding: 'base64', commitment },
    ])
    return r.value.map(toAccount)
  }

  /** Token balance in base units, or null if the account does not exist. */
  async getTokenAccountBalance(key: PublicKey, commitment: Commitment = 'confirmed'): Promise<bigint | null> {
    try {
      const r = await this.call<{ value: { amount: string } }>('getTokenAccountBalance', [key.toBase58(), { commitment }])
      return BigInt(r.value.amount)
    } catch (e) {
      if (e instanceof RpcError && (e.code === -32602 || /could not find account/i.test(e.message))) return null
      throw e
    }
  }

  sendTransaction(base64: string, timeoutMs = 5_000): Promise<string> {
    return this.call<string>(
      'sendTransaction',
      [base64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }],
      timeoutMs,
    )
  }

  async getSignatureStatuses(signatures: string[]): Promise<(SignatureStatus | null)[]> {
    const r = await this.call<{ value: (SignatureStatus | null)[] }>(
      'getSignatureStatuses',
      [signatures, { searchTransactionHistory: false }],
      4_000,
    )
    return r.value
  }

  async simulateTransaction(base64: string, commitment: Commitment = 'processed'): Promise<SimulationResult> {
    const r = await this.call<{ value: { err: unknown; logs: string[] | null; unitsConsumed?: number } }>(
      'simulateTransaction',
      [base64, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment }],
      8_000,
    )
    return { err: r.value.err, logs: r.value.logs ?? [], unitsConsumed: r.value.unitsConsumed }
  }

  getRecentPrioritizationFees(keys: PublicKey[]) {
    return this.call<{ slot: number; prioritizationFee: number }[]>('getRecentPrioritizationFees', [
      keys.map((k) => k.toBase58()),
    ])
  }

  /** Lamport change of `account` in a landed transaction (fees, tips and rent included). */
  async getBalanceDelta(signature: string, account: PublicKey): Promise<{ delta: bigint; fee: bigint; slot: number } | null> {
    const r = await this.call<{
      slot: number
      meta: { fee: number; preBalances: number[]; postBalances: number[] } | null
      transaction: { message: { accountKeys: (string | { pubkey: string })[] } }
    } | null>('getTransaction', [
      signature,
      { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
    ])
    if (!r?.meta) return null
    const target = account.toBase58()
    const idx = r.transaction.message.accountKeys.findIndex((k) => (typeof k === 'string' ? k : k.pubkey) === target)
    if (idx < 0) return null
    const pre = r.meta.preBalances[idx] ?? 0
    const post = r.meta.postBalances[idx] ?? 0
    return { delta: BigInt(post - pre), fee: BigInt(r.meta.fee), slot: r.slot }
  }
}
