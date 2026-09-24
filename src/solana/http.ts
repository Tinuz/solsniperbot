import { Agent, interceptors, request } from 'undici'

/**
 * Shared keep-alive agent. Re-using warm TCP+TLS connections is worth
 * 50-150ms per request versus a cold handshake, which matters most on the
 * transaction submission path.
 */
export const httpAgent = new Agent({
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 300_000,
  connections: 64,
  pipelining: 1,
  connect: { timeout: 5_000 },
})

/** Metadata fetches (IPFS gateways etc.) may redirect; RPC traffic never does. */
const redirectingAgent = httpAgent.compose(interceptors.redirect({ maxRedirections: 3 }))

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 300)}`)
  }
}

export interface HttpOptions {
  timeoutMs?: number
  headers?: Record<string, string>
}

export async function postJson<T = unknown>(url: string, payload: string, opts: HttpOptions = {}): Promise<T> {
  const timeout = opts.timeoutMs ?? 10_000
  const res = await request(url, {
    method: 'POST',
    body: payload,
    headers: { 'content-type': 'application/json', ...opts.headers },
    dispatcher: httpAgent,
    headersTimeout: timeout,
    bodyTimeout: timeout,
  })
  const text = await res.body.text()
  if (res.statusCode >= 400) throw new HttpError(res.statusCode, text)
  return JSON.parse(text) as T
}

export async function getText(url: string, opts: HttpOptions & { maxBytes?: number } = {}): Promise<string> {
  const timeout = opts.timeoutMs ?? 10_000
  const res = await request(url, {
    method: 'GET',
    headers: opts.headers,
    dispatcher: redirectingAgent,
    headersTimeout: timeout,
    bodyTimeout: timeout,
  })
  if (res.statusCode >= 400) {
    await res.body.dump()
    throw new HttpError(res.statusCode, '')
  }
  const max = opts.maxBytes ?? 256 * 1024
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of res.body) {
    size += (chunk as Buffer).length
    if (size > max) {
      res.body.destroy()
      throw new Error(`response exceeds ${max} bytes`)
    }
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}
