import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import pino from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { type Config, loadConfig } from '../src/config.js'
import { Engine } from '../src/engine.js'
import { positionPnl } from '../src/trading/positions.js'
import { MockChain } from './mock-chain.js'

/**
 * Money must never get lost between the bot's memory and the chain: not at a
 * shutdown with transactions in flight, not after a crash, not when the RPC
 * hiccups while the bot restarts. Live mode against the mock chain.
 */

const log = pino({ level: process.env.TEST_LOG ?? 'silent' })
const START_LAMPORTS = 10_000_000_000n

async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 8_000, label = 'condition'): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`timed out waiting for ${label}`)
}

interface Rig {
  chain: MockChain
  cfg: Config
  wallet: Keypair
  engine: Engine
  alerts: string[]
  dataDir: string
}
const rigs: Rig[] = []

afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.engine.stop().catch(() => undefined)
    await r.chain.stop()
    rmSync(r.dataDir, { recursive: true, force: true })
  }
})

async function live(env: Record<string, string> = {}): Promise<Rig> {
  const chain = new MockChain()
  const port = await chain.start()
  const dataDir = mkdtempSync(join(tmpdir(), 'lifecycle-'))
  const wallet = Keypair.generate()
  chain.fund(wallet.publicKey, START_LAMPORTS)
  const cfg = loadConfig({
    RPC_URL: `http://127.0.0.1:${port}`,
    WS_URL: `ws://127.0.0.1:${port}`,
    DATA_DIR: dataDir,
    DRY_RUN: 'false',
    PRIVATE_KEY: bs58.encode(wallet.secretKey),
    LANDING: 'rpc',
    BUY_SOL: '0.1',
    DEV_BUY_MAX_SOL: '10',
    TAKE_PROFIT: '500:100',
    STOP_LOSS_PCT: '90',
    EXIT_ON_DEV_SELL: 'true',
    REQUIRE_EDGE: 'false',
    API_PORT: '0',
    ...env,
  })
  const rig = { chain, cfg, wallet, dataDir, ...(await startEngine(cfg, wallet)) }
  rigs.push(rig)
  return rig
}

async function startEngine(cfg: Config, wallet: Keypair): Promise<{ engine: Engine; alerts: string[] }> {
  const engine = new Engine(cfg, wallet, log, { drainMs: 300 })
  await engine.start()
  const alerts = engine.takeEarlyAlerts()
  engine.on('alert', (m) => alerts.push(m))
  await waitFor(() => engine.status().feeds[0]?.connected, 5_000, 'feed connection')
  await new Promise((r) => setTimeout(r, 50))
  return { engine, alerts }
}

/** Stops the bot, lets `between` happen while it is down, and starts it again on the same data. */
async function restart(rig: Rig, between: () => void | Promise<void> = () => {}): Promise<void> {
  await rig.engine.stop()
  await between()
  Object.assign(rig, await startEngine(rig.cfg, rig.wallet))
}

const saved = (rig: Rig) => JSON.parse(readFileSync(join(rig.dataDir, 'positions.json'), 'utf8')) as Record<string, unknown>[]
const walletChange = (rig: Rig) => rig.chain.balanceOf(rig.wallet.publicKey) - START_LAMPORTS

async function bought(rig: Rig, symbol = 'LIVE') {
  const { mint, dev } = rig.chain.launch({ symbol, devBuyLamports: 1_000_000_000n })
  const m = mint.toBase58()
  await waitFor(() => rig.engine.positions.get(m)?.status === 'open', 8_000, 'buy')
  // Its fill reconciled against the chain before the test goes on.
  await waitFor(() => rig.engine.positions.get(m)?.reconciled, 8_000, 'buy reconciled')
  return { mint, dev, m }
}

describe('shutdown with transactions in flight', () => {
  it('keeps a buy it could not see land, and settles it on-chain at the next start', async () => {
    const rig = await live()
    rig.chain.holdNext = 1
    const { mint } = rig.chain.launch({ symbol: 'HELD', devBuyLamports: 1_000_000_000n })
    const m = mint.toBase58()
    const sig = await waitFor(() => rig.engine.positions.get(m)?.pending?.signature, 5_000, 'buy submitted')

    await restart(rig, async () => {
      // Stopped while in flight: saved as a pending buy, not booked as failed.
      const [p] = saved(rig)
      expect(p).toMatchObject({ mint: m, status: 'opening', pending: { side: 'buy', signature: sig } })
      expect(rig.engine.positions.history().some((h) => h.mint === m)).toBe(false)
      // It lands while the bot is down.
      rig.chain.release()
      await new Promise((r) => setTimeout(r, 100))
    })

    const pos = await waitFor(() => rig.engine.positions.get(m)?.status === 'open' && rig.engine.positions.get(m), 5_000, 'restored buy')
    expect(pos.tokensHeld).toBe(rig.chain.tokensOf(mint, rig.wallet.publicKey))
    expect(pos.buySignature).toBe(sig)
    expect(pos.pending).toBeUndefined()
    const exact = await waitFor(() => rig.engine.positions.get(m)?.reconciled && rig.engine.positions.get(m), 8_000, 'reconciled')
    expect(exact.walletDeltaLamports).toBe(walletChange(rig))
  })

  it('drops a buy that never landed, without booking a loss', async () => {
    const rig = await live()
    rig.chain.holdNext = 1
    const { mint } = rig.chain.launch({ symbol: 'LOST', devBuyLamports: 1_000_000_000n })
    const m = mint.toBase58()
    await waitFor(() => rig.engine.positions.get(m)?.pending?.signature, 5_000, 'buy submitted')
    await restart(rig, () => rig.chain.dropHeld())
    const gone = await waitFor(() => rig.engine.positions.history().find((p) => p.mint === m), 5_000, 'settled')
    expect(gone).toMatchObject({ status: 'failed', error: 'buy never landed', networkFeesLamports: 0n })
    expect(rig.engine.positions.has(m)).toBe(false)
    expect(rig.engine.status().pnl.closed).toBe(0)
  })

  it('keeps a sell it could not see land, and books it exactly once it did', async () => {
    const rig = await live()
    const { mint, dev, m } = await bought(rig)
    rig.chain.holdNext = 1
    rig.chain.trade(mint, { user: dev, sellTokens: 10_000_000_000_000n }) // dev dumps: exit
    await waitFor(() => rig.engine.positions.get(m)?.pending?.side === 'sell', 5_000, 'sell submitted')

    await restart(rig, async () => {
      expect(saved(rig)[0]).toMatchObject({ mint: m, pending: { side: 'sell', reason: 'dev sold' } })
      rig.chain.release()
      await new Promise((r) => setTimeout(r, 100))
    })

    const closed = await waitFor(() => rig.engine.positions.history().find((p) => p.mint === m && p.reconciled), 10_000, 'sold and reconciled')
    expect(closed.status).toBe('closed')
    expect(closed.estimated).toBeUndefined()
    // Not a false loss: the P&L is the wallet's exact change over the buy and the sell.
    expect(positionPnl(closed)).toBe(walletChange(rig))
    expect(rig.chain.landed.filter((t) => t.kind === 'sell')).toHaveLength(1)
  })
})

describe('restart after a crash', () => {
  it('trusts the chain over the saved holdings, and books missing tokens at the last price, not as a loss', async () => {
    const rig = await live()
    const { mint, m } = await bought(rig)
    const held = rig.engine.positions.get(m)!.tokensHeld
    await restart(rig, () => rig.chain.drain(mint, rig.wallet.publicKey, held / 2n))

    const pos = await waitFor(() => {
      const p = rig.engine.positions.get(m)
      return p && !p.pending && p.tokensHeld < held && p
    }, 5_000, 'synced')
    expect(pos.tokensHeld).toBe(held - held / 2n)
    expect(pos.sells).toHaveLength(1)
    expect(pos.sells[0]!.lamports > 0n).toBe(true)
    expect(pos.estimated).toMatch(/without a sale the bot saw/)
    expect(rig.alerts.some((a) => /tokens left the wallet/.test(a))).toBe(true)
  })

  it('never drops a position because the RPC failed while restarting', async () => {
    const rig = await live()
    const { m } = await bought(rig)
    await restart(rig, () => {
      rig.chain.failing.add('getTokenAccountBalance')
    })
    const pos = rig.engine.positions.get(m)!
    expect(pos).toBeDefined()
    expect(pos.pending?.side).toBe('sync') // waits for the chain before trading again
    rig.chain.failing.clear()
  })

  it('keeps the other mode’s positions when DRY_RUN changes, and says so', async () => {
    const rig = await live()
    const { m } = await bought(rig)
    await rig.engine.stop()
    const paper = loadConfig({ RPC_URL: rig.cfg.rpcUrl, WS_URL: rig.cfg.wsUrl, DATA_DIR: rig.dataDir, REQUIRE_EDGE: 'false', API_PORT: '0' })
    Object.assign(rig, await startEngine(paper, rig.wallet))
    expect(rig.engine.positions.has(m)).toBe(false)
    expect(rig.alerts.some((a) => /1 live position\(s\).*kept but not managed/.test(a))).toBe(true)
    await rig.engine.stop()
    // Still in the file after the paper run saved it.
    expect(saved(rig).map((p) => p.mint)).toEqual([m])
    Object.assign(rig, await startEngine(rig.cfg, rig.wallet))
    expect(rig.engine.positions.has(m)).toBe(true)
  })
})

describe('entries and exits', () => {
  it('never buys the same coin twice at once', async () => {
    const rig = await live({ REQUIRE_EDGE: 'false' })
    const { mint } = rig.chain.launch({ symbol: 'TWICE', devBuyLamports: 1_000_000_000n })
    const m = mint.toBase58()
    await waitFor(() => rig.engine.positions.has(m), 5_000, 'auto buy')
    await expect(rig.engine.manualBuy(m)).rejects.toThrow(/already holding/)
    // One the bot itself passes on (the dev bought too much), bought by hand with a double click.
    const other = rig.chain.launch({ symbol: 'CLICK', devBuyLamports: 12_000_000_000n }).mint.toBase58()
    await waitFor(() => rig.engine.recentLaunches().find((l) => l.mint === other && l.verdict === 'rejected'), 5_000, 'rejected launch')
    const clicks = await Promise.allSettled([rig.engine.manualBuy(other, 0.05), rig.engine.manualBuy(other, 0.05)])
    expect(clicks.filter((c) => c.status === 'fulfilled')).toHaveLength(1)
    expect(clicks.find((c) => c.status === 'rejected')).toMatchObject({ reason: expect.objectContaining({ message: expect.stringMatching(/already holding or buying/) }) })
    await new Promise((r) => setTimeout(r, 200))
    expect(rig.chain.landed.filter((t) => t.kind === 'buy')).toHaveLength(2)
  })

  it('retries a failed sell with wider slippage, books its fee, and closes the token account afterwards', async () => {
    const rig = await live()
    const { mint, dev, m } = await bought(rig)
    rig.chain.failNextSells = 1
    rig.chain.trade(mint, { user: dev, sellTokens: 10_000_000_000_000n })
    const closed = await waitFor(() => rig.engine.positions.history().find((p) => p.mint === m && p.status === 'closed'), 8_000, 'exit')
    const sells = rig.chain.landed.filter((t) => t.kind === 'sell')
    expect(sells).toHaveLength(2)
    // The retry could not close the account in the same transaction: a separate close gets the rent back.
    expect(sells[1]!.closesAccount).toBe(false)
    await waitFor(() => rig.chain.landed.some((t) => t.kind === 'close'), 8_000, 'account closed')
    const exact = await waitFor(() => {
      const p = rig.engine.positions.history().find((h) => h.mint === m)
      return p?.reconciled && p.landedTxs === 4 && p
    }, 10_000, 'reconciled with the close')
    expect(positionPnl(exact)).toBe(walletChange(rig))
    expect(closed.networkFeesLamports > 0n).toBe(true)
  })

  it('tells the owner when an exit keeps failing', async () => {
    const rig = await live({ SELL_RETRIES: '0' })
    const { mint, dev, m } = await bought(rig)
    rig.chain.failNextSells = 100
    rig.chain.trade(mint, { user: dev, sellTokens: 10_000_000_000_000n })
    await waitFor(() => rig.alerts.find((a) => /selling keeps failing \(3 rounds/.test(a)), 15_000, 'stuck-exit alert')
    expect(rig.engine.positions.get(m)?.status).toBe('open')
    rig.chain.failNextSells = 0
  }, 20_000)
})

describe('risk limits across restarts', () => {
  it('keeps a pause and the day’s losses when the bot restarts', async () => {
    const rig = await live({ DAILY_LOSS_LIMIT_SOL: '0.5' })
    rig.engine.risk.pause('manual')
    rig.engine.risk.recordRealized(-200_000_000n)
    await restart(rig)
    expect(rig.engine.risk.snapshot()).toMatchObject({ paused: true, pauseReason: 'manual', realizedTodayLamports: -200_000_000n })
    const { mint } = rig.chain.launch({ symbol: 'NOPE', devBuyLamports: 1_000_000_000n })
    const view = await waitFor(() => rig.engine.recentLaunches().find((l) => l.mint === mint.toBase58() && l.verdict === 'skipped'), 5_000, 'skipped')
    expect(view.reason).toMatch(/paused: manual/)
  })
})
