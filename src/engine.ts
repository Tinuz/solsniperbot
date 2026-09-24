import { EventEmitter } from 'node:events'
import { type Keypair, PublicKey } from '@solana/web3.js'
import { type Config, lamportsToSol } from './config.js'
import { GrpcFeed } from './feed/grpc-feed.js'
import { LogsFeed } from './feed/logs-feed.js'
import { type Launch, MarketBook, type MintState } from './feed/market.js'
import type { Feed, FeedTx } from './feed/types.js'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './pump/constants.js'
import { curveFromAccount, curveProgressBps, marketCapLamports, spotPriceLamports } from './pump/curve.js'
import { decodeBondingCurve } from './pump/layouts.js'
import { bondingCurvePda } from './pump/pda.js'
import { PumpProtocol } from './pump/protocol.js'
import { BlockhashCache } from './solana/blockhash.js'
import { SignatureTracker } from './solana/confirm.js'
import { Lander } from './solana/landing.js'
import { PriorityFees } from './solana/priority-fee.js'
import { RpcClient } from './solana/rpc.js'
import { CreatorReputation } from './strategy/creators.js'
import { staticFilter } from './strategy/filters.js'
import { MetadataFetcher, hasSocials } from './strategy/metadata.js'
import { decideMomentum } from './strategy/momentum.js'
import { RiskManager } from './strategy/risk.js'
import { AmmSeller } from './trading/amm.js'
import { Executor } from './trading/executor.js'
import { type Position, PositionManager, positionPnl } from './trading/positions.js'
import type { Logger } from './util/logger.js'
import { nowMs } from './util/time.js'

export interface LaunchView {
  mint: string
  name: string
  symbol: string
  dev: string
  at: number
  slot: number
  source: string
  devBuySol: number
  mcapSol: number
  curvePct: number
  verdict: 'rejected' | 'watching' | 'buying' | 'skipped'
  reason: string
}

export type EngineEvent =
  | { type: 'launch'; data: LaunchView }
  | { type: 'launch-update'; data: Pick<LaunchView, 'mint' | 'verdict' | 'reason'> }
  | { type: 'position'; data: Position }
  | { type: 'closed'; data: Position }
  | { type: 'notice'; data: { level: 'info' | 'warn' | 'error'; message: string; at: number } }

const percentile = (values: number[], p: number) => {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

class Samples {
  private values: number[] = []
  constructor(private readonly cap = 200) {}
  add(v: number | undefined) {
    if (v === undefined || !Number.isFinite(v)) return
    this.values.push(v)
    if (this.values.length > this.cap) this.values.shift()
  }
  summary() {
    return { n: this.values.length, p50: percentile(this.values, 50), p90: percentile(this.values, 90) }
  }
}

/** Wires feeds, strategy, risk and execution together. */
export class Engine extends EventEmitter<{ event: [EngineEvent] }> {
  readonly rpc: RpcClient
  readonly protocol: PumpProtocol
  readonly market: MarketBook
  readonly risk: RiskManager
  readonly positions: PositionManager
  readonly executor: Executor
  private readonly blockhash: BlockhashCache
  private readonly fees: PriorityFees
  private readonly lander?: Lander
  private readonly tracker: SignatureTracker
  private readonly creators: CreatorReputation
  private readonly metadata = new MetadataFetcher()
  private readonly feeds: Feed[] = []
  private readonly momentum = new Map<string, { launch: Launch; state: MintState }>()
  private readonly entering = new Set<string>()
  private readonly launches: LaunchView[] = []
  private readonly latency = { detectToSend: new Samples(), land: new Samples(), slots: new Samples(), decide: new Samples() }
  private readonly counters = { launches: 0, rejected: 0, entries: 0, txs: 0 }
  private balance: bigint | null = null
  private timers: NodeJS.Timeout[] = []
  private readonly startedAt = Date.now()

  constructor(
    readonly cfg: Config,
    private readonly wallet: Keypair | undefined,
    private readonly log: Logger,
  ) {
    super()
    this.rpc = new RpcClient(cfg.rpcUrl)
    this.protocol = new PumpProtocol(this.rpc, log)
    this.market = new MarketBook(this.protocol)
    this.risk = new RiskManager(cfg)
    this.blockhash = new BlockhashCache(this.rpc, log)
    this.fees = new PriorityFees(cfg, this.rpc, log, () => this.protocol.hotAccounts())
    this.lander = cfg.dryRun ? undefined : new Lander(cfg, this.rpc, log)
    this.tracker = new SignatureTracker(
      this.rpc,
      this.blockhash,
      this.lander,
      { pollMs: 400, rebroadcastMs: cfg.rebroadcastIntervalMs, rebroadcastMax: cfg.rebroadcastMax },
      log,
    )
    this.creators = new CreatorReputation(cfg.dataDir, cfg.filters.creatorWindowMs, log)
    this.executor = new Executor({
      cfg,
      rpc: this.rpc,
      protocol: this.protocol,
      market: this.market,
      blockhash: this.blockhash,
      fees: this.fees,
      tracker: this.tracker,
      lander: this.lander,
      amm: new AmmSeller(cfg.rpcUrl),
      wallet,
      log,
    })
    this.positions = new PositionManager({
      cfg,
      executor: this.executor,
      market: this.market,
      protocol: this.protocol,
      risk: this.risk,
      rpc: this.rpc,
      log,
    })

    if (cfg.feed === 'grpc' && cfg.grpc) this.feeds.push(new GrpcFeed(cfg.grpc, log))
    else this.feeds.push(new LogsFeed(cfg.wsUrl, log))
  }

  // Lifecycle -------------------------------------------------------------------

  async start(): Promise<void> {
    const { cfg, log } = this
    log.info(
      { mode: cfg.dryRun ? 'PAPER' : 'LIVE', wallet: this.executor.walletAddress.toBase58(), feed: cfg.feed, landing: cfg.dryRun ? 'none (paper)' : cfg.landing, entry: cfg.entryMode, buySol: lamportsToSol(cfg.buyLamports) },
      'starting engine',
    )
    if (cfg.dryRun && !this.wallet) log.warn('no wallet configured: paper trading with an ephemeral address')

    await this.protocol.start()
    log.info(
      { feeTiers: this.protocol.feeConfig?.feeTiers.length ?? 0, createV2: this.protocol.global?.createV2Enabled },
      'loaded pump protocol state',
    )
    await this.blockhash.start()
    if (this.lander) {
      await this.lander.start()
      log.info({ targets: this.lander.targetNames }, 'submission paths ready')
    }
    this.fees.start()
    this.tracker.start()
    await this.creators.load()
    await this.positions.start()
    if (!cfg.dryRun) await this.refreshBalance()

    this.positions.on('update', (p) => this.emit('event', { type: 'position', data: p }))
    this.positions.on('closed', (p) => {
      this.emit('event', { type: 'closed', data: p })
      if (!cfg.dryRun) void this.refreshBalance()
    })
    this.market.on('launch', (l, s) => this.onLaunch(l, s))
    this.market.on('trade', (state) => this.onTrade(state))
    this.market.on('complete', (state) => this.positions.onMarket(state))
    this.market.on('migration', (state) => this.positions.onMarket(state))

    for (const feed of this.feeds) {
      feed.on('tx', (tx) => this.onFeedTx(tx))
      feed.on('preview', (p) => this.market.ingestPreview(p))
      feed.on('status', (up) => this.notice(up ? 'info' : 'warn', `${feed.name} feed ${up ? 'connected' : 'disconnected'}`))
      await feed.start()
    }

    this.timers.push(
      setInterval(() => this.evaluateMomentum(), 250),
      setInterval(() => this.market.prune(30 * 60_000), 60_000),
    )
    if (!cfg.dryRun) this.timers.push(setInterval(() => void this.refreshBalance(), 15_000))
    log.info('engine running')
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t)
    for (const f of this.feeds) f.stop()
    this.fees.stop()
    this.lander?.stop()
    this.blockhash.stop()
    this.protocol.stop()
    await this.positions.stop()
    this.tracker.stop()
    await this.creators.flush()
  }

  // Stream handling -----------------------------------------------------------

  private onFeedTx(tx: FeedTx): void {
    this.counters.txs++
    // Order matters: capture our own fill before the tracker resolves the outcome.
    this.executor.onFeedTx(tx)
    this.tracker.observe(tx.signature, tx.err, tx.slot)
    this.market.ingest(tx)
  }

  private onTrade(state: MintState): void {
    this.positions.onMarket(state)
    const watched = this.momentum.get(state.mintStr)
    if (watched) this.checkMomentum(state.mintStr, watched.launch, watched.state)
  }

  private onLaunch(launch: Launch, state: MintState): void {
    const decideStart = nowMs()
    this.counters.launches++
    const dev = launch.dev.toBase58()
    const creatorLaunches = this.creators.record(dev)
    const verdict = staticFilter(launch, this.cfg.filters, {
      initialRealTokenReserves: this.protocol.initialRealTokenReserves,
      creatorLaunches,
    })
    const view: LaunchView = {
      mint: launch.mintStr,
      name: launch.name,
      symbol: launch.symbol,
      dev,
      at: launch.detectedAtWall,
      slot: launch.slot,
      source: launch.source,
      devBuySol: lamportsToSol(launch.devBuyLamports),
      mcapSol: lamportsToSol(marketCapLamports(launch.curve)),
      curvePct: curveProgressBps(launch.curve, this.protocol.initialRealTokenReserves) / 100,
      verdict: 'rejected',
      reason: '',
    }

    if (!verdict.pass) {
      this.counters.rejected++
      view.reason = verdict.reason
      this.recordLaunch(view)
      this.log.debug({ mint: launch.mintStr, symbol: launch.symbol, reason: verdict.reason }, 'launch rejected')
      return
    }

    if (this.cfg.entryMode === 'momentum') {
      view.verdict = 'watching'
      view.reason = 'waiting for momentum'
      this.recordLaunch(view)
      this.momentum.set(launch.mintStr, { launch, state })
      return
    }

    view.verdict = 'buying'
    view.reason = 'instant snipe'
    this.recordLaunch(view)
    this.latency.decide.add(nowMs() - decideStart)
    void this.enter(launch, state, 'instant snipe')
  }

  private evaluateMomentum(): void {
    for (const [mint, w] of this.momentum) this.checkMomentum(mint, w.launch, w.state)
  }

  private checkMomentum(mint: string, launch: Launch, state: MintState): void {
    const d = decideMomentum(state, launch, this.cfg.momentum, this.cfg.filters.maxEntryMcapLamports)
    if (d.action === 'wait') return
    this.momentum.delete(mint)
    if (d.action === 'reject') {
      this.updateLaunch(mint, 'rejected', d.reason)
      return
    }
    this.updateLaunch(mint, 'buying', d.reason)
    void this.enter(launch, state, `momentum: ${d.reason}`)
  }

  // Entry ---------------------------------------------------------------------

  private async enter(launch: Launch, state: MintState, reason: string): Promise<void> {
    const mint = launch.mintStr
    if (this.entering.has(mint) || this.positions.has(mint)) return
    this.entering.add(mint)
    try {
      if (this.cfg.filters.requireSocials) {
        const meta = await this.metadata.fetch(launch.uri, this.cfg.filters.metadataTimeoutMs)
        if (!hasSocials(meta)) {
          this.updateLaunch(mint, 'rejected', meta ? 'no socials in metadata' : 'metadata unavailable')
          return
        }
      }

      // No await between this check and positions.open() registering the
      // position, so concurrent launches cannot overshoot the limits.
      const risk = this.risk.canBuy({
        openPositions: this.positions.openCount,
        balanceLamports: this.balance,
        sizeLamports: this.cfg.buyLamports,
        priorityLamports: this.cfg.buyPriorityLamports,
      })
      if (!risk.pass) {
        this.updateLaunch(mint, 'skipped', risk.reason)
        return
      }

      const sendStart = nowMs()
      this.counters.entries++
      const pos = await this.positions.open({
        mint: launch.mint,
        tokenProgram: launch.tokenProgram,
        creator: state.curve.creator,
        isMayhemMode: launch.isMayhemMode,
        curve: state.curve,
        lamports: this.cfg.buyLamports,
        slippageBps: this.cfg.buySlippageBps,
        name: launch.name,
        symbol: launch.symbol,
        dev: launch.dev.toBase58(),
        reason,
        launchSlot: launch.slot,
      })
      if (pos.timings) {
        this.latency.detectToSend.add(sendStart - launch.detectedAt + pos.timings.buildMs + pos.timings.sendMs)
        this.latency.land.add(pos.timings.landMs)
      }
      this.latency.slots.add(pos.slotsAfterLaunch)
      if (pos.status === 'failed') this.notice('warn', `buy ${launch.symbol} failed: ${pos.error}`)
      else this.notice('info', `bought ${launch.symbol} (${reason})`)
    } catch (err) {
      this.log.error({ err, mint }, 'entry failed')
      this.notice('error', `entry ${launch.symbol} crashed: ${(err as Error).message}`)
    } finally {
      this.entering.delete(mint)
    }
  }

  // Manual controls (API) -----------------------------------------------------

  /** Buys any coin still on its bonding curve, whether or not the bot saw it launch. */
  async manualBuy(mintStr: string, sol?: number): Promise<Position> {
    const mint = new PublicKey(mintStr)
    if (this.positions.has(mintStr)) throw new Error('already holding this coin')
    let state = this.market.get(mintStr)
    const [curveAcct, mintAcct] = await this.rpc.getMultipleAccounts([bondingCurvePda(mint), mint])
    if (!curveAcct) throw new Error('no pump bonding curve for this mint')
    if (!mintAcct) throw new Error('mint account not found')
    const tokenProgram = mintAcct.owner
    if (!tokenProgram.equals(TOKEN_PROGRAM_ID) && !tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) throw new Error('mint is not an SPL token')
    const bc = decodeBondingCurve(curveAcct.data)
    if (bc.complete) throw new Error('coin has graduated; buy it on PumpSwap instead')
    if (!bc.quoteMint.equals(PublicKey.default)) throw new Error('only SOL-paired coins are supported')
    state = this.market.seed(mint, curveFromAccount(bc), state?.curveSlot ?? 0)
    const lamports = sol ? BigInt(Math.round(sol * 1e9)) : this.cfg.buyLamports
    const risk = this.risk.canBuy({ openPositions: this.positions.openCount, balanceLamports: this.balance, sizeLamports: lamports, priorityLamports: this.cfg.buyPriorityLamports })
    if (!risk.pass) throw new Error(risk.reason)
    return this.positions.open({
      mint,
      tokenProgram,
      creator: state.curve.creator,
      isMayhemMode: bc.isMayhemMode,
      curve: state.curve,
      lamports,
      slippageBps: this.cfg.buySlippageBps,
      name: state.launch?.name ?? mintStr.slice(0, 6),
      symbol: state.launch?.symbol ?? '?',
      reason: 'manual buy',
    })
  }

  // Status --------------------------------------------------------------------

  status() {
    const stats = this.positions.stats()
    const open = this.positions.list()
    const unrealized = open.reduce((sum, p) => sum + positionPnl(p), 0n)
    return {
      mode: this.cfg.dryRun ? 'paper' : 'live',
      wallet: this.executor.walletAddress.toBase58(),
      balanceSol: this.balance === null ? null : lamportsToSol(this.balance),
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      feeds: this.feeds.map((f) => f.stats()),
      landing: this.lander ? { mode: this.cfg.landing, targets: this.lander.targetNames } : null,
      blockhashAgeMs: this.blockhash.ageMs,
      priorityFeeSampled: this.fees.sampled.toString(),
      trackedMints: this.market.size,
      pendingTxs: this.tracker.size,
      counters: { ...this.counters, watching: this.momentum.size },
      risk: { ...this.risk.snapshot(), realizedTodaySol: lamportsToSol(this.risk.snapshot().realizedTodayLamports) },
      pnl: {
        closed: stats.closed,
        wins: stats.wins,
        losses: stats.losses,
        winRate: stats.closed ? stats.wins / stats.closed : null,
        realizedSol: lamportsToSol(stats.netPnlLamports),
        unrealizedSol: lamportsToSol(unrealized),
        bestSol: lamportsToSol(stats.bestPnlLamports),
        worstSol: lamportsToSol(stats.worstPnlLamports),
        avgHoldSec: stats.avgHoldMs / 1000,
      },
      latency: {
        decideMs: this.latency.decide.summary(),
        detectToSendMs: this.latency.detectToSend.summary(),
        landMs: this.latency.land.summary(),
        slotsAfterLaunch: this.latency.slots.summary(),
      },
    }
  }

  recentLaunches(): LaunchView[] {
    return this.launches.slice()
  }

  /** Spot price and progress for a tracked mint, for the dashboard. */
  marketView(mint: string) {
    const s = this.market.get(mint)
    if (!s) return undefined
    return {
      priceSol: spotPriceLamports(s.curve) / 1e9,
      mcapSol: lamportsToSol(marketCapLamports(s.curve)),
      curvePct: curveProgressBps(s.curve, this.protocol.initialRealTokenReserves) / 100,
      buyers: s.buyers.size,
      trades: s.trades,
      devSold: s.devSold,
      complete: s.complete,
    }
  }

  // Helpers -------------------------------------------------------------------

  private async refreshBalance(): Promise<void> {
    try {
      this.balance = await this.rpc.getBalance(this.executor.walletAddress)
    } catch (err) {
      this.log.debug({ err: (err as Error).message }, 'balance refresh failed')
    }
  }

  private recordLaunch(view: LaunchView): void {
    this.launches.unshift(view)
    if (this.launches.length > 300) this.launches.pop()
    this.emit('event', { type: 'launch', data: view })
  }

  private updateLaunch(mint: string, verdict: LaunchView['verdict'], reason: string): void {
    const view = this.launches.find((l) => l.mint === mint)
    if (view) {
      view.verdict = verdict
      view.reason = reason
    }
    this.emit('event', { type: 'launch-update', data: { mint, verdict, reason } })
  }

  private notice(level: 'info' | 'warn' | 'error', message: string): void {
    this.emit('event', { type: 'notice', data: { level, message, at: Date.now() } })
  }
}
