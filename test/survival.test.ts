import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { DeadError, Survival, feeSchedule, minViableBuyLamports } from '../src/strategy/survival.js'
import type { Position } from '../src/trading/positions.js'

const log = pino({ level: 'silent' })
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function cfg(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'survival-'))
  dirs.push(dir)
  return loadConfig({ RPC_URL: 'https://rpc.example.com', DATA_DIR: dir, ...env })
}

const SOL = 1_000_000_000n

function position(over: Partial<Position> = {}): Position {
  return {
    mint: 'M', name: 'n', symbol: 's', tokenProgram: 't', creator: 'c', isMayhemMode: false, paper: true,
    status: 'open', entryReason: '', openedAt: 0, costLamports: 0n, tokensBought: 1n, tokensHeld: 1n,
    realizedLamports: 0n, networkFeesLamports: 0n, landedTxs: 0, reconciledTxs: 0, reconciled: false,
    tiersDone: 0, gainPct: 0, peakGainPct: 0, valueLamports: 0n, lastPriceAt: 0, sells: [], sellAttempts: 0, nextSellAt: 0,
    ...over,
  }
}

async function survival(env: Record<string, string> = {}) {
  const c = cfg(env)
  const s = new Survival(c, log, 0)
  await s.load()
  return { s, c }
}

describe('trade viability', () => {
  it('refuses trades that fees would eat', () => {
    const c = cfg()
    // Default Jito landing: 0.001 tip each way + 0.0005/0.0003 priority + base fees.
    expect(feeSchedule(c).roundTrip).toBe(2_810_000n)
    expect(minViableBuyLamports(c)).toBe(28_100_000n) // 10% max fee drag
    expect(minViableBuyLamports(cfg({ MAX_FEE_DRAG_PCT: '50' }))).toBe(20_000_000n) // floored at MIN_BUY_SOL
  })
})

describe('sizing', () => {
  it('uses BUY_SOL in fixed mode while the paper wallet is healthy', async () => {
    const { s } = await survival({ PAPER_START_SOL: '1', BUY_SOL: '0.05' })
    const v = s.compute({ walletLamports: null, open: [] })
    expect(v.state).toBe('healthy')
    expect(v.balanceLamports).toBe(SOL)
    expect(v.nextBuyLamports).toBe(50_000_000n)
  })

  it('scales with the bankroll in fraction mode, never below the viable minimum', async () => {
    const big = await survival({ PAPER_START_SOL: '1', SIZING: 'fraction', BUY_FRACTION_PCT: '5', BUY_SOL: '0.1' })
    expect(big.s.compute({ walletLamports: null, open: [] }).nextBuyLamports).toBe(49_000_000n) // 5% of 0.98 free
    const small = await survival({ PAPER_START_SOL: '0.2', SIZING: 'fraction', BUY_FRACTION_PCT: '5', BUY_SOL: '0.1' })
    expect(small.s.compute({ walletLamports: null, open: [] }).nextBuyLamports).toBe(28_100_000n)
  })

  it('halves size in a drawdown and shrinks to what is affordable', async () => {
    const { s } = await survival({ PAPER_START_SOL: '1', BUY_SOL: '0.1', DEFENSIVE_DRAWDOWN_PCT: '30' })
    s.bookClosed(position({ status: 'closed', costLamports: 400_000_000n, realizedLamports: 50_000_000n }))
    const v = s.compute({ walletLamports: null, open: [] })
    expect(v.drawdownPct).toBeCloseTo(35, 1)
    expect(v.state).toBe('defensive')
    expect(v.nextBuyLamports).toBe(50_000_000n)

    const tight = await survival({ PAPER_START_SOL: '0.1', BUY_SOL: '0.1' })
    // 0.1 - 0.02 reserve - upfront (tip+priority+base+account rent) = 0.0740 SOL
    expect(tight.s.compute({ walletLamports: null, open: [] }).nextBuyLamports).toBe(74_000_000n - 5_000n)
  })
})

describe('life and death', () => {
  it('goes critical while positions can still bring money back, and dies once flat', async () => {
    const { s } = await survival({ PAPER_START_SOL: '0.1', BUY_SOL: '0.05' })
    const open = [position({ costLamports: 60_000_000n, valueLamports: 20_000_000n })]
    expect(s.check({ walletLamports: null, open, busy: false }).state).toBe('critical')

    let died = false
    s.onDeath(() => {
      died = true
    })
    // It closed at a loss: 0.1 - 0.06 + 0.005 = 0.045 SOL left, but a viable trade needs 0.0541
    // (0.0281 minimum + 0.006 upfront costs + 0.02 exit reserve).
    s.bookClosed(position({ status: 'closed', costLamports: 60_000_000n, realizedLamports: 5_000_000n }))
    expect(s.check({ walletLamports: null, open: [], busy: false }, 1_000).state).toBe('critical') // confirming
    expect(died).toBe(false)
    const v = s.check({ walletLamports: null, open: [], busy: false }, 2_000)
    expect(v.state).toBe('dead')
    expect(v.reason).toMatch(/insufficient funds to trade/)
    expect(died).toBe(true)
    expect(s.isDead).toBe(true)
  })

  it('never dies while a transaction is in flight', async () => {
    const { s } = await survival({ PAPER_START_SOL: '0.05' })
    for (let i = 0; i < 5; i++) expect(s.check({ walletLamports: null, open: [], busy: true }, i * 10_000).state).toBe('critical')
    expect(s.isDead).toBe(false)
  })

  it('dies when a live wallet is emptied, but not on an unknown balance', async () => {
    const { s } = await survival({ DRY_RUN: 'false', PRIVATE_KEY: '[1]' })
    expect(s.check({ walletLamports: null, open: [], busy: false }, 0).state).toBe('critical')
    s.check({ walletLamports: 0n, open: [], busy: false }, 1_000)
    expect(s.check({ walletLamports: 0n, open: [], busy: false }, 2_000)).toMatchObject({ state: 'dead', reason: 'wallet is empty' })
  })

  it('stays dead across restarts until the wallet can trade again', async () => {
    const c = cfg({ PAPER_START_SOL: '0.03' })
    const first = new Survival(c, log, 0)
    await first.load()
    first.check({ walletLamports: null, open: [], busy: false }, 0)
    first.check({ walletLamports: null, open: [], busy: false }, 1)
    expect(first.isDead).toBe(true)
    await first.flush()

    const again = new Survival(c, log, 0)
    await again.load()
    expect(again.isDead).toBe(true)
    expect(() => again.reviveOrThrow({ walletLamports: null, open: [] })).toThrow(DeadError)

    const reset = new Survival(loadConfig({ RPC_URL: 'https://rpc.example.com', DATA_DIR: c.dataDir, PAPER_START_SOL: '1', PAPER_RESET: 'true' }), log, 0)
    await reset.load()
    expect(reset.isDead).toBe(false)
    expect(reset.compute({ walletLamports: null, open: [] }).balanceLamports).toBe(SOL)
  })

  it('revives a live bot whose wallet was topped up', async () => {
    const c = cfg({ DRY_RUN: 'false', PRIVATE_KEY: '[1]' })
    const s = new Survival(c, log, 0)
    await s.load()
    s.check({ walletLamports: 1_000n, open: [], busy: false }, 0)
    s.check({ walletLamports: 1_000n, open: [], busy: false }, 1)
    expect(s.isDead).toBe(true)
    expect(() => s.reviveOrThrow({ walletLamports: 1_000n, open: [] })).toThrow(/Fund the wallet to at least 0.05/)
    s.reviveOrThrow({ walletLamports: SOL, open: [] })
    expect(s.isDead).toBe(false)
  })
})
