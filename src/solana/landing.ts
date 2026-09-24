import { PublicKey } from '@solana/web3.js'
import type { Config } from '../config.js'
import type { Logger } from '../util/logger.js'
import { nowMs } from '../util/time.js'
import { getText, postJson } from './http.js'
import type { RpcClient } from './rpc.js'

/** From the official helius-sdk (`SENDER_TIP_ACCOUNTS`). */
export const HELIUS_SENDER_TIP_ACCOUNTS = [
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
  'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
  '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
  '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
  '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
  '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
  '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
].map((k) => new PublicKey(k))

interface Target {
  name: string
  /** Plain RPCs honour `maxRetries: 0`, so the bot re-broadcasts to them itself. */
  rebroadcast: boolean
  send(base64: string): Promise<unknown>
}

export interface SendResult {
  target: string
  ok: boolean
  ms: number
  error?: string
}

const rpcBody = (base64: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'sendTransaction',
    params: [base64, { encoding: 'base64', ...extra }],
  })

async function rpcSend(url: string, body: string, timeoutMs: number): Promise<unknown> {
  const res = await postJson<{ result?: unknown; error?: { message: string } }>(url, body, { timeoutMs })
  if (res.error) throw new Error(res.error.message)
  return res.result
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * Fans a signed transaction out to every configured submission path at once.
 * All paths receive the *same* signed bytes, so at most one copy can land:
 * there is no double-buy risk from multi-path submission.
 */
export class Lander {
  private readonly targets: Target[] = []
  private tipAccounts: PublicKey[] = []
  private warmTimer?: NodeJS.Timeout

  constructor(
    private readonly cfg: Config,
    private readonly rpc: RpcClient,
    private readonly log: Logger,
  ) {
    const rpcTarget = (url: string): Target => ({
      name: `rpc:${hostOf(url)}`,
      rebroadcast: true,
      send: (b64) => rpcSend(url, rpcBody(b64, { skipPreflight: true, maxRetries: 0 }), 4_000),
    })
    this.targets.push(rpcTarget(cfg.rpcUrl), ...cfg.sendRpcUrls.map(rpcTarget))

    if (cfg.landing === 'helius') {
      const url = cfg.heliusSwqosOnly ? `${cfg.heliusSenderUrl}?swqos_only=true` : cfg.heliusSenderUrl
      this.targets.push({
        name: 'helius-sender',
        rebroadcast: false,
        send: (b64) => rpcSend(url, rpcBody(b64, { skipPreflight: true, maxRetries: 0 }), 4_000),
      })
      this.tipAccounts = HELIUS_SENDER_TIP_ACCOUNTS
    }

    if (cfg.landing === 'jito') {
      for (const base of cfg.jitoUrls) {
        const qs = cfg.jitoAuthUuid ? `?uuid=${encodeURIComponent(cfg.jitoAuthUuid)}` : ''
        const url = `${base.replace(/\/+$/, '')}/api/v1/transactions${qs}`
        this.targets.push({
          name: `jito:${hostOf(base)}`,
          rebroadcast: false,
          send: (b64) => rpcSend(url, rpcBody(b64), 4_000),
        })
      }
    }
  }

  get targetNames(): string[] {
    return this.targets.map((t) => t.name)
  }

  get tipsEnabled(): boolean {
    return this.cfg.landing !== 'rpc'
  }

  async start(): Promise<void> {
    if (this.cfg.landing === 'jito') this.tipAccounts = await this.loadJitoTipAccounts()
    this.warmTimer = setInterval(() => void this.keepWarm(), 20_000)
    await this.keepWarm()
  }

  stop(): void {
    clearInterval(this.warmTimer)
  }

  /** A random tip account; spreading tips avoids write-lock contention on one account. */
  tipAccount(): PublicKey {
    const acct = this.tipAccounts[Math.floor(Math.random() * this.tipAccounts.length)]
    if (!acct) throw new Error('no tip accounts available')
    return acct
  }

  /**
   * Sends to all targets concurrently. Resolves as soon as one accepts the
   * transaction (or all have failed); stragglers are logged when they finish.
   */
  broadcast(base64: string, signature: string): Promise<SendResult[]> {
    const started = nowMs()
    const results: SendResult[] = []
    return new Promise((resolve) => {
      let pending = this.targets.length
      let resolved = false
      for (const t of this.targets) {
        t.send(base64).then(
          () => {
            results.push({ target: t.name, ok: true, ms: nowMs() - started })
          },
          (err: Error) => {
            results.push({ target: t.name, ok: false, ms: nowMs() - started, error: err.message })
          },
        ).finally(() => {
          pending--
          const last = results[results.length - 1]!
          if (!resolved && (last.ok || pending === 0)) {
            resolved = true
            resolve(results.slice())
          }
          if (pending === 0) {
            const failed = results.filter((r) => !r.ok)
            if (failed.length) this.log.debug({ signature, failed }, 'some submission paths rejected the transaction')
          }
        })
      }
    })
  }

  /** Re-sends to the plain RPC targets only (landing services dedupe on their side). */
  async rebroadcast(base64: string): Promise<void> {
    await Promise.allSettled(this.targets.filter((t) => t.rebroadcast).map((t) => t.send(base64)))
  }

  private async loadJitoTipAccounts(): Promise<PublicKey[]> {
    const override = process.env.JITO_TIP_ACCOUNTS
    if (override) return override.split(',').map((k) => new PublicKey(k.trim()))
    const errors: string[] = []
    for (const base of this.cfg.jitoUrls) {
      try {
        const qs = this.cfg.jitoAuthUuid ? `?uuid=${encodeURIComponent(this.cfg.jitoAuthUuid)}` : ''
        const res = await postJson<{ result?: string[] }>(
          `${base.replace(/\/+$/, '')}/api/v1/bundles${qs}`,
          JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTipAccounts', params: [] }),
          { timeoutMs: 5_000 },
        )
        if (res.result?.length) {
          this.log.info({ count: res.result.length }, 'loaded Jito tip accounts')
          return res.result.map((k) => new PublicKey(k))
        }
      } catch (e) {
        errors.push(`${hostOf(base)}: ${(e as Error).message}`)
      }
    }
    // Tips are real transfers, so never guess an address.
    throw new Error(`could not load Jito tip accounts (${errors.join('; ')}); set JITO_TIP_ACCOUNTS to override`)
  }

  /** Keeps TLS sessions to every submission path warm between trades. */
  private async keepWarm(): Promise<void> {
    const health = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' })
    const tasks: Promise<unknown>[] = [
      this.rpc.getSlot().catch(() => undefined),
      ...this.cfg.sendRpcUrls.map((u) => postJson(u, health, { timeoutMs: 3_000 }).catch(() => undefined)),
    ]
    if (this.cfg.landing === 'helius') {
      const ping = this.cfg.heliusSenderUrl.replace(/\/fast\/?(\?.*)?$/, '/ping')
      tasks.push(getText(ping, { timeoutMs: 3_000 }).catch(() => undefined))
    }
    if (this.cfg.landing === 'jito') {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTipAccounts', params: [] })
      for (const base of this.cfg.jitoUrls) {
        tasks.push(postJson(`${base.replace(/\/+$/, '')}/api/v1/bundles`, body, { timeoutMs: 3_000 }).catch(() => undefined))
      }
    }
    await Promise.all(tasks)
  }
}
