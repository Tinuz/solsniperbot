/**
 * Offline demo: runs the real engine + dashboard in paper mode against a
 * simulated chain that launches coins and trades them (some pump, some get
 * rugged by their dev). No RPC key needed; nothing touches mainnet.
 *
 *   npm run demo            -> http://localhost:8787
 *
 * Useful for exploring the dashboard and tuning filters/exits. The market
 * behaviour is random and says nothing about real profitability.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Keypair, type PublicKey } from '@solana/web3.js'
import { ApiServer } from '../src/api/server.js'
import { loadConfig } from '../src/config.js'
import { Engine } from '../src/engine.js'
import { createLogger } from '../src/util/logger.js'
import { MockChain } from '../test/mock-chain.js'

const ADJ = ['Based', 'Moon', 'Turbo', 'Giga', 'Baby', 'Super', 'Dark', 'Happy', 'Sad', 'Lil', 'Mega', 'Rich']
const NOUN = ['Pepe', 'Doge', 'Cat', 'Frog', 'Ape', 'Wojak', 'Inu', 'Hamster', 'Penguin', 'Goat', 'Bonk', 'Rug']
const pick = <T>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)]!
const sol = (x: number) => BigInt(Math.round(x * 1e9))

const chain = new MockChain()
const port = await chain.start()
const cfg = loadConfig({
  ...process.env,
  RPC_URL: `http://127.0.0.1:${port}`,
  WS_URL: `ws://127.0.0.1:${port}`,
  DRY_RUN: 'true',
  FEED: 'ws',
  DATA_DIR: process.env.DATA_DIR ?? mkdtempSync(join(tmpdir(), 'sniper-demo-')),
  API_PORT: process.env.API_PORT ?? '8787',
  PAPER_LATENCY_MS: process.env.PAPER_LATENCY_MS ?? '120',
  MAX_HOLD_SECONDS: process.env.MAX_HOLD_SECONDS ?? '90',
  STALE_SECONDS: process.env.STALE_SECONDS ?? '20',
  NAME_BLOCKLIST: process.env.NAME_BLOCKLIST ?? 'rug|scam',
})
const log = createLogger(cfg.logLevel)
const engine = new Engine(cfg, undefined, log)
const api = new ApiServer(engine, log)
await engine.start()
const url = await api.start()
log.info({ url }, 'DEMO MODE: simulated chain, simulated coins, paper trades only')

type Script = { mint: PublicKey; dev: PublicKey; kind: 'pump' | 'rug' | 'dud'; step: number }
const live: Script[] = []

setInterval(() => {
  const r = Math.random()
  const { mint, dev } = chain.launch({
    name: `${pick(ADJ)} ${pick(NOUN)}`,
    symbol: `${pick(NOUN).toUpperCase().slice(0, 4)}${Math.floor(Math.random() * 90 + 10)}`,
    devBuyLamports: sol(Math.random() < 0.15 ? 3 + Math.random() * 4 : Math.random() * 1.5),
  })
  live.push({ mint, dev, kind: r < 0.3 ? 'pump' : r < 0.6 ? 'rug' : 'dud', step: 0 })
  if (live.length > 12) live.shift()
}, 2_500)

setInterval(() => {
  for (const s of live) {
    s.step++
    if (s.kind === 'pump' && s.step < 25) chain.trade(s.mint, { buyLamports: sol(0.2 + Math.random() * 1.2), user: Keypair.generate().publicKey })
    if (s.kind === 'pump' && s.step > 18 && Math.random() < 0.3) chain.trade(s.mint, { sellTokens: 5_000_000_000_000n })
    if (s.kind === 'rug' && s.step < 4) chain.trade(s.mint, { buyLamports: sol(0.1 + Math.random() * 0.5) })
    if (s.kind === 'rug' && s.step === 6) chain.trade(s.mint, { user: s.dev, sellTokens: 20_000_000_000_000n })
    if (s.kind === 'dud' && Math.random() < 0.2) chain.trade(s.mint, { buyLamports: sol(Math.random() * 0.1) })
  }
}, 700)

const stop = async () => {
  await api.stop()
  await engine.stop()
  await chain.stop()
  process.exit(0)
}
process.on('SIGINT', () => void stop())
process.on('SIGTERM', () => void stop())
