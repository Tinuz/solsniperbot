import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Keypair, PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import pino from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiServer } from '../src/api/server.js'
import { loadConfig } from '../src/config.js'
import { Engine, type EngineEvent } from '../src/engine.js'
import type { LaunchRecord } from '../src/learning/record.js'
import { DeadError } from '../src/strategy/survival.js'
import { PUMP_PROGRAM_ID } from '../src/pump/constants.js'
import { positionPnl } from '../src/trading/positions.js'
import { MockChain } from './mock-chain.js'

const log = pino({ level: process.env.TEST_LOG ?? 'silent' })

async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 8_000, label = 'condition'): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`timed out waiting for ${label}`)
}

interface Harness {
  chain: MockChain
  engine: Engine
  events: EngineEvent[]
  dataDir: string
  api?: ApiServer
  apiUrl?: string
}
let h: Harness | undefined

async function boot(env: Record<string, string>, wallet?: Keypair, withApi = false): Promise<Harness> {
  const chain = new MockChain()
  const port = await chain.start()
  const dataDir = mkdtempSync(join(tmpdir(), 'sniper-'))
  const cfg = loadConfig({
    RPC_URL: `http://127.0.0.1:${port}`,
    WS_URL: `ws://127.0.0.1:${port}`,
    DATA_DIR: dataDir,
    PAPER_LATENCY_MS: '30',
    DEV_BUY_MAX_SOL: '10',
    API_PORT: '0',
    // The mock also plays the Jito block engine.
    JITO_BLOCK_ENGINE_URLS: `http://127.0.0.1:${port}`,
    // These tests are about trading mechanics; the edge gate has its own test.
    REQUIRE_EDGE: 'false',
    ...env,
  })
  if (wallet) chain.fund(wallet.publicKey, 10_000_000_000n)
  const engine = new Engine(cfg, wallet, log)
  const events: EngineEvent[] = []
  engine.on('event', (e) => events.push(e))
  await engine.start()
  let api: ApiServer | undefined
  let apiUrl: string | undefined
  if (withApi) {
    api = new ApiServer(engine, log)
    apiUrl = await api.start()
  }
  // Let the websocket subscribe before the test starts emitting.
  await waitFor(() => engine.status().feeds[0]?.connected, 5_000, 'feed connection')
  await new Promise((r) => setTimeout(r, 50))
  h = { chain, engine, events, dataDir, api, apiUrl }
  return h
}

afterEach(async () => {
  if (!h) return
  await h.api?.stop()
  await h.engine.stop()
  await h.chain.stop()
  rmSync(h.dataDir, { recursive: true, force: true })
  h = undefined
})

describe('paper trading end to end', () => {
  it('snipes a launch from the log stream and exits at take-profit', async () => {
    const { chain, engine } = await boot({ TAKE_PROFIT: '40:100', BUY_SOL: '0.1' })
    const { mint } = chain.launch({ symbol: 'MOON', devBuyLamports: 500_000_000n })

    const pos = await waitFor(() => engine.positions.get(mint.toBase58())?.status === 'open' && engine.positions.get(mint.toBase58()), 5_000, 'paper position')
    expect(pos.paper).toBe(true)
    expect(pos.tokensBought > 0n).toBe(true)
    expect(Number(pos.costLamports)).toBeLessThanOrEqual(100_000_000)

    // Organic buying pushes the price well past +40%.
    for (let i = 0; i < 6; i++) chain.trade(mint, { buyLamports: 2_000_000_000n })

    const closed = await waitFor(() => engine.positions.history().find((p) => p.mint === mint.toBase58() && p.status === 'closed'), 8_000, 'take profit')
    expect(closed.closeReason).toMatch(/take profit/)
    expect(positionPnl(closed) > 0n).toBe(true)
    expect(engine.status().pnl.wins).toBe(1)
    // What a metered RPC provider would bill is visible.
    expect(engine.status().usage.streamedMb).toBeGreaterThan(0)
    expect(engine.status().usage.rpcCalls).toBeGreaterThan(0)
  })

  it('takes a free ride: sells all but the moonbag, frees the slot, and stops the moonbag above entry', async () => {
    const { chain, engine } = await boot({ TAKE_PROFIT: '60:50,150:100', BUY_SOL: '0.1', MOONBAG_PCT: '25', MAX_OPEN_POSITIONS: '1' })
    const a = chain.launch({ symbol: 'RIDE', devBuyLamports: 500_000_000n }).mint.toBase58()
    await waitFor(() => engine.positions.get(a)?.status === 'open', 5_000, 'paper position')

    // Buyers push it past the free-ride point: 75% is sold, a quarter rides.
    for (let i = 0; i < 8; i++) chain.trade(new PublicKey(a), { buyLamports: 2_000_000_000n })
    const bag = await waitFor(() => engine.positions.get(a)?.moonbag && engine.positions.get(a), 8_000, 'moonbag')
    expect(bag.sells[0]!.reason).toMatch(/^free ride/)
    expect(Number(bag.tokensHeld) / Number(bag.tokensBought)).toBeCloseTo(0.25, 2)
    // Stake, fees and the secured profit are in: the moonbag is free.
    expect(bag.realizedLamports - bag.costLamports - bag.networkFeesLamports > 10_000_000n).toBe(true)
    // It no longer takes up the only position slot: the next launch is bought.
    expect(engine.positions.openCount).toBe(0)
    expect(engine.positions.moonbagCount).toBe(1)
    const b = chain.launch({ symbol: 'NEXT', devBuyLamports: 500_000_000n }).mint.toBase58()
    await waitFor(() => engine.positions.get(b)?.status === 'open', 5_000, 'second position')

    // A big holder dumps: the moonbag is sold at its break-even stop, and the trade as a whole made money.
    chain.trade(new PublicKey(a), { sellTokens: 300_000_000_000_000n })
    const closed = await waitFor(() => engine.positions.history().find((p) => p.mint === a && p.status === 'closed'), 8_000, 'moonbag stop')
    expect(closed.closeReason).toMatch(/^moonbag stop at \+\d+\.\d%/)
    expect(positionPnl(closed) > 10_000_000n).toBe(true)
  })

  it('rejects launches that fail the filters and never buys them', async () => {
    const { chain, engine, events } = await boot({ NAME_BLOCKLIST: 'rug', DEV_BUY_MAX_SOL: '1' })
    chain.launch({ name: 'Total Rug', symbol: 'RUG' })
    chain.launch({ symbol: 'WHALE', devBuyLamports: 3_000_000_000n })
    await waitFor(() => events.filter((e) => e.type === 'launch').length === 2, 5_000, 'launch events')
    const reasons = engine.recentLaunches().map((l) => `${l.verdict}:${l.reason}`)
    expect(reasons.some((r) => r === 'rejected:name blocklisted')).toBe(true)
    expect(reasons.some((r) => /rejected:dev buy .* above max/.test(r))).toBe(true)
    expect(engine.positions.openCount).toBe(0)
  })

  it('waits for momentum before entering in momentum mode', async () => {
    const { chain, engine } = await boot({
      ENTRY_MODE: 'momentum',
      MOMENTUM_MIN_AGE_MS: '100',
      MOMENTUM_MAX_AGE_MS: '5000',
      MOMENTUM_MIN_BUYERS: '3',
      MOMENTUM_MIN_NET_BUY_SOL: '1',
    })
    const { mint } = chain.launch({ symbol: 'MOMO', devBuyLamports: 200_000_000n })
    await new Promise((r) => setTimeout(r, 300))
    expect(engine.positions.has(mint.toBase58())).toBe(false)
    for (let i = 0; i < 3; i++) chain.trade(mint, { buyLamports: 500_000_000n })
    await waitFor(() => engine.positions.has(mint.toBase58()), 5_000, 'momentum entry')
    expect(engine.recentLaunches()[0]?.reason).toMatch(/3 buyers/)
  })

  it('only watches and records until the settings have a proven edge', async () => {
    const { chain, engine } = await boot({ REQUIRE_EDGE: 'auto', RECORD_HORIZON_MIN: '0.01' })
    const { mint } = chain.launch({ symbol: 'WAIT', devBuyLamports: 500_000_000n })
    const view = await waitFor(() => engine.recentLaunches().find((l) => l.mint === mint.toBase58() && l.verdict === 'skipped'), 5_000, 'observed launch')
    expect(view.reason).toMatch(/^observing: /)
    expect(engine.positions.has(mint.toBase58())).toBe(false)
    const tuning = engine.status().tuning as { edge: { required: boolean; allowed: boolean } }
    expect(tuning.edge).toMatchObject({ required: true, allowed: false })
    // Still learning: the launch is recorded even though it was not bought.
    await waitFor(() => (engine.recorder?.stats().written ?? 0) >= 1, 5_000, 'recorded launch')
  })
})

describe('live trading end to end (mock chain, Jito landing)', () => {
  it('signs, tips, lands via all paths once, and exits when the dev dumps', async () => {
    const wallet = Keypair.generate()
    const { chain, engine } = await boot(
      {
        DRY_RUN: 'false',
        PRIVATE_KEY: bs58.encode(wallet.secretKey),
        LANDING: 'jito',
        TIP_SOL: '0.0002',
        BUY_SOL: '0.2',
        TAKE_PROFIT: '500:100',
        STOP_LOSS_PCT: '90',
        EXIT_ON_DEV_SELL: 'true',
      },
      wallet,
    )
    const { mint, dev } = chain.launch({ symbol: 'LIVE', devBuyLamports: 1_000_000_000n })

    const pos = await waitFor(() => engine.positions.get(mint.toBase58())?.status === 'open' && engine.positions.get(mint.toBase58()), 8_000, 'live buy')
    const buyTx = chain.landed.find((t) => t.kind === 'buy')!
    expect(buyTx.programs).toContain(PUMP_PROGRAM_ID.toBase58())
    expect(buyTx.tipLamports).toBe(200_000n)
    expect(chain.tipAccounts.map((k) => k.toBase58())).toContain(buyTx.tipAccount)
    expect(buyTx.computeUnitLimit).toBe(180_000)
    // Same signed bytes reached both the RPC and the block engine; it landed once.
    await waitFor(() => buyTx.receivedBy.length >= 2, 3_000, 'second submission path')
    expect(new Set(buyTx.receivedBy)).toEqual(new Set(['rpc', 'jito']))
    expect(chain.landed.filter((t) => t.kind === 'buy')).toHaveLength(1)
    // Fill amounts come from our own TradeEvent: exact, not estimated.
    expect(pos.tokensBought > 0n).toBe(true)
    expect(pos.costLamports <= 200_000_000n && pos.costLamports > 195_000_000n).toBe(true)

    // The dev dumps: the bot must exit and close its token account for the rent.
    chain.trade(mint, { user: dev, sellTokens: 10_000_000_000_000n })
    const closed = await waitFor(() => engine.positions.history().find((p) => p.mint === mint.toBase58() && p.status === 'closed'), 8_000, 'dev-sell exit')
    expect(closed.closeReason).toBe('dev sold')
    const sellTx = chain.landed.find((t) => t.kind === 'sell')!
    expect(sellTx.closesAccount).toBe(true)

    // At close, P&L is estimated (sell not yet reconciled): trade result minus estimated fees.
    const estimate = Number(positionPnl(closed)) / 1e9
    expect(estimate).toBeLessThan(0)
    expect(estimate).toBeGreaterThan(-0.05)

    // Reconciliation replaces estimates with the exact wallet delta.
    const reconciled = await waitFor(() => engine.positions.history().find((p) => p.mint === mint.toBase58() && p.reconciled), 10_000, 'reconciliation')
    const exactChange = chain.balanceOf(wallet.publicKey) - 10_000_000_000n
    expect(reconciled.walletDeltaLamports).toBe(exactChange)
    expect(positionPnl(reconciled)).toBe(exactChange)
    expect(engine.status().pnl.realizedSol).toBeCloseTo(Number(exactChange) / 1e9, 9)
  })

  it('books only the network fee when a buy fails on-chain', async () => {
    const wallet = Keypair.generate()
    const { chain, engine } = await boot(
      { DRY_RUN: 'false', PRIVATE_KEY: bs58.encode(wallet.secretKey), LANDING: 'rpc', BUY_SOL: '0.1' },
      wallet,
    )
    chain.failNextBuys = 1
    const { mint } = chain.launch({ symbol: 'FAIL', devBuyLamports: 300_000_000n })
    const failed = await waitFor(() => engine.positions.history().find((p) => p.mint === mint.toBase58()), 8_000, 'failed buy')
    expect(failed.status).toBe('failed')
    expect(failed.error).toMatch(/slippage/)
    expect(failed.costLamports).toBe(0n)
    expect(positionPnl(failed) < 0n && positionPnl(failed) > -2_000_000n).toBe(true)
  })
})

describe('survival', () => {
  it('shuts itself down when it can no longer fund a viable trade, and stays down on restart', async () => {
    const { chain, engine, dataDir } = await boot({ PAPER_START_SOL: '0.056', BUY_SOL: '0.05', MAX_HOLD_SECONDS: '1' })
    const deaths: string[] = []
    engine.on('dead', (v) => deaths.push(v.reason))

    // Only 0.03 SOL is affordable after the exit reserve and upfront costs, so the buy shrinks.
    const { mint } = chain.launch({ symbol: 'LAST', devBuyLamports: 300_000_000n })
    const pos = await waitFor(() => engine.positions.get(mint.toBase58())?.status === 'open' && engine.positions.get(mint.toBase58()), 5_000, 'buy')
    expect(pos.costLamports <= 30_000_000n && pos.costLamports > 29_000_000n).toBe(true)

    // Max hold closes it; fees leave the wallet below what a viable trade needs.
    await waitFor(() => deaths.length > 0, 15_000, 'death')
    expect(deaths[0]).toMatch(/insufficient funds to trade/)
    expect(engine.status().survival.state).toBe('dead')

    // New launches are no longer bought.
    const { mint: next } = chain.launch({ symbol: 'NOPE' })
    await waitFor(() => engine.recentLaunches().find((l) => l.mint === next.toBase58() && l.verdict === 'skipped'), 3_000, 'skip')

    // A restart refuses to run while the (paper) wallet is still insufficient.
    await engine.stop()
    const again = new Engine(loadConfig({ RPC_URL: engine.cfg.rpcUrl, WS_URL: engine.cfg.wsUrl, DATA_DIR: dataDir, PAPER_START_SOL: '0.056', BUY_SOL: '0.05', REQUIRE_EDGE: 'false' }), undefined, log)
    await expect(again.start()).rejects.toBeInstanceOf(DeadError)
    await again.stop()
  }, 30_000)
})

describe('launch recording', () => {
  it('records rejected and traded launches with their trade paths and results', async () => {
    const { chain, engine, dataDir } = await boot({ NAME_BLOCKLIST: 'skip', RECORD_HORIZON_MIN: '0.04', MAX_HOLD_SECONDS: '1' })
    const { mint: rejected, dev } = chain.launch({ name: 'Skip Me', symbol: 'SKIP', devBuyLamports: 200_000_000n })
    const { mint: bought } = chain.launch({ name: 'Take Me', symbol: 'TAKE', devBuyLamports: 400_000_000n })
    await waitFor(() => engine.positions.get(bought.toBase58())?.status === 'open', 5_000, 'buy')
    chain.trade(rejected, { buyLamports: 1_000_000_000n })
    chain.trade(rejected, { user: dev, sellTokens: 1_000_000_000_000n })
    chain.trade(bought, { buyLamports: 500_000_000n })

    const records = await waitFor(() => {
      const dir = join(dataDir, 'launches')
      let files: string[] = []
      try {
        files = readdirSync(dir)
      } catch {
        return undefined
      }
      const rows = files.flatMap((f) => readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as LaunchRecord))
      return rows.length >= 2 ? rows : undefined
    }, 10_000, 'records')

    const r = records.find((x) => x.mint === rejected.toBase58())!
    expect(r.verdict).toBe('rejected')
    expect(r.reason).toBe('name blocklisted')
    expect(r.trades).toHaveLength(2)
    expect(r.trades[1]![5]).toBe(0) // the dev's wallet index
    expect(r.summary.devSold).toBe(true)
    expect(r.summary.maxMultiple).toBeGreaterThan(1)
    expect(r.devBuyLamports).toBeGreaterThan(190_000_000)

    const b = records.find((x) => x.mint === bought.toBase58())!
    expect(b.verdict).toBe('buying')
    expect(b.position?.paper).toBe(true)
    expect(b.position?.exits).toEqual(['max hold time'])
    expect(b.trades.length).toBeGreaterThanOrEqual(1)
  }, 20_000)
})

describe('control API', () => {
  it('serves status and enforces its request checks', async () => {
    const { apiUrl, engine } = await boot({}, undefined, true)
    const base = apiUrl!

    const status = (await fetch(`${base}/api/status`).then((r) => r.json())) as { mode: string }
    expect(status.mode).toBe('paper')

    const noJson = await fetch(`${base}/api/pause`, { method: 'POST', body: '{}', headers: { 'content-type': 'text/plain' } })
    expect(noJson.status).toBe(415)

    const crossOrigin = await fetch(`${base}/api/pause`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', origin: 'https://evil.example' } })
    expect(crossOrigin.status).toBe(403)

    const ok = await fetch(`${base}/api/pause`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
    expect(ok.status).toBe(200)
    expect(engine.risk.snapshot().paused).toBe(true)

    const page = await fetch(`${base}/`).then((r) => r.text())
    expect(page).toContain('<title>Sol Sniper</title>')
  })
})
