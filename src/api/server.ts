import { readFile } from 'node:fs/promises'
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { publicConfig } from '../config.js'
import type { Engine, EngineEvent } from '../engine.js'
import { toJson } from '../util/json.js'
import type { Logger } from '../util/logger.js'

const MAX_BODY = 16 * 1024
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new HttpError(413, 'body too large')
    chunks.push(chunk as Buffer)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  } catch {
    throw new HttpError(400, 'invalid JSON')
  }
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  const payload = type === 'application/json' ? toJson(body) : String(body)
  res.writeHead(status, {
    'content-type': `${type}; charset=utf-8`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}

/**
 * Local control API + live dashboard.
 *
 * Browsers can reach localhost from any website, so every request is checked:
 * the Host header must be local (blocks DNS rebinding), cross-origin requests
 * are refused, and mutating calls require a JSON body (which forces a CORS
 * preflight that this server never approves). Set API_TOKEN to also require
 * a bearer token.
 */
export class ApiServer {
  private readonly server = createServer((req, res) => void this.handle(req, res))
  private readonly wss = new WebSocketServer({ noServer: true })
  private statusTimer?: NodeJS.Timeout
  private dashboard?: string

  constructor(
    private readonly engine: Engine,
    private readonly log: Logger,
  ) {
    this.server.on('upgrade', (req, socket, head) => {
      if (new URL(req.url ?? '/', 'http://x').pathname !== '/ws' || !this.authorized(req)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws))
    })
    engine.on('event', (e) => this.broadcast(e))
  }

  async start(): Promise<string> {
    const { host, port, token } = this.engine.cfg.api
    this.dashboard = await readFile(new URL('./dashboard.html', import.meta.url), 'utf8')
    if (!LOCAL_HOSTS.has(host) && !token) {
      this.log.warn({ host }, 'API is bound to a non-local interface without API_TOKEN: anyone who can reach it can trade your wallet')
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, host, resolve)
    })
    this.statusTimer = setInterval(() => this.broadcast({ type: 'status', data: this.engine.status() }), 2_000)
    const addr = this.server.address() as AddressInfo
    const url = `http://${LOCAL_HOSTS.has(host) || host === '0.0.0.0' ? 'localhost' : host}:${addr.port}`
    this.log.info({ url }, 'dashboard ready')
    return url
  }

  async stop(): Promise<void> {
    clearInterval(this.statusTimer)
    for (const c of this.wss.clients) c.terminate()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  /**
   * Without API_TOKEN only local Host headers are accepted (a rebinding page
   * cannot forge one). With a token set, the token is what gates access, so
   * the dashboard also works over a LAN address.
   */
  private hostAllowed(req: IncomingMessage): boolean {
    if (this.engine.cfg.api.token) return true
    const hostHeader = (req.headers.host ?? '').replace(/:\d+$/, '')
    return LOCAL_HOSTS.has(hostHeader) || hostHeader === this.engine.cfg.api.host
  }

  private authorized(req: IncomingMessage): boolean {
    if (!this.hostAllowed(req)) return false

    const origin = req.headers.origin
    if (origin) {
      try {
        if (new URL(origin).host !== req.headers.host) return false
      } catch {
        return false
      }
    }

    const token = this.engine.cfg.api.token
    if (!token) return true
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    const query = new URL(req.url ?? '/', 'http://x').searchParams.get('token')
    return bearer === token || query === token
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x')
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        // The page itself holds no data; it authenticates its API calls.
        if (!this.hostAllowed(req)) throw new HttpError(403, 'forbidden')
        return send(res, 200, this.dashboard, 'text/html')
      }
      if (!this.authorized(req)) throw new HttpError(403, 'forbidden')

      if (req.method === 'GET') {
        switch (url.pathname) {
          case '/api/status':
            return send(res, 200, this.engine.status())
          case '/api/positions':
            return send(res, 200, { open: this.engine.positions.list(), closed: this.engine.positions.history() })
          case '/api/launches':
            return send(res, 200, this.engine.recentLaunches())
          case '/api/config':
            return send(res, 200, publicConfig(this.engine.cfg))
        }
        throw new HttpError(404, 'not found')
      }

      if (req.method === 'POST') {
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'content-type must be application/json')
        const body = await readBody(req)
        switch (url.pathname) {
          case '/api/pause':
            this.engine.risk.pause('manual')
            return send(res, 200, { ok: true })
          case '/api/resume':
            this.engine.risk.resume()
            return send(res, 200, { ok: true })
          case '/api/sell': {
            const mint = String(body.mint ?? '')
            const pct = Number(body.pct ?? 100)
            if (!this.engine.positions.has(mint)) throw new HttpError(404, 'no open position for mint')
            if (!(pct > 0 && pct <= 100)) throw new HttpError(400, 'pct must be in (0, 100]')
            const ok = await this.engine.positions.sell(mint, pct, 'manual sell')
            return send(res, ok ? 200 : 409, { ok })
          }
          case '/api/sell-all':
            await this.engine.positions.sellAll('manual sell-all')
            return send(res, 200, { ok: true })
          case '/api/buy': {
            const mint = String(body.mint ?? '')
            const sol = body.sol === undefined || body.sol === '' ? undefined : Number(body.sol)
            if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) throw new HttpError(400, 'invalid mint address')
            if (sol !== undefined && !(sol > 0 && sol <= 1000)) throw new HttpError(400, 'invalid SOL amount')
            try {
              const pos = await this.engine.manualBuy(mint, sol)
              return send(res, pos.status === 'failed' ? 409 : 200, pos)
            } catch (e) {
              throw new HttpError(400, (e as Error).message)
            }
          }
        }
        throw new HttpError(404, 'not found')
      }
      throw new HttpError(405, 'method not allowed')
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500
      if (status === 500) this.log.error({ err: e, path: url.pathname }, 'API error')
      send(res, status, { error: (e as Error).message })
    }
  }

  private onSocket(ws: WebSocket): void {
    ws.send(
      toJson({
        type: 'snapshot',
        data: {
          status: this.engine.status(),
          config: publicConfig(this.engine.cfg),
          positions: this.engine.positions.list(),
          closed: this.engine.positions.history(),
          launches: this.engine.recentLaunches(),
        },
      }),
    )
  }

  private broadcast(event: EngineEvent | { type: 'status'; data: unknown }): void {
    if (this.wss.clients.size === 0) return
    const payload = toJson(event)
    for (const c of this.wss.clients) if (c.readyState === c.OPEN) c.send(payload)
  }
}
