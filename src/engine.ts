import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { type Keypair, PublicKey } from '@solana/web3.js'
import { type Config, lamportsToSol } from './config.js'
import { GrpcFeed } from './feed/grpc-feed.js'
import { LogsFeed } from './feed/logs-feed.js'
import { type Launch, MarketBook, type MintState } from './feed/market.js'
import type { Feed, FeedTx } from './feed/types.js'
import { AutoTuner } from './learning/autotune.js'
import { LaunchRecorder } from './learning/recorder.js'
import { paramsFromConfig, settingsFingerprint } from './learning/tunable.js'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './pump/constants.js'
import { curveFromAccount, curveProgressBps, feeRates, marketCapLamports, spotPriceLamports } from './pump/curve.js'
import type { TradeEvent } from './pump/events.js'
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
import { decideMomentum, momentumSnapshot } from './strategy/momentum.js'
import { SMART_WINDOW_DAYS, WalletBook, readWalletEntries } from './learning/wallets.js'
import { RiskManager } from './strategy/risk.js'
import { OperatingCosts } from './strategy/costs.js'
import { Survival, type Vitals } from './strategy/survival.js'
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

/** How long a shutdown waits for buys and sells in flight to land before it stops watching them. */
const DRAIN_MS = 10_000

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

const lamportsView = (v: Vitals) => ({
  state: v.state,
  reason: v.reason,
  balanceSol: v.balanceLamports === null ? null : lamportsToSol(v.balanceLamports),
  equitySol: v.equityLamports === null ? null : lamportsToSol(v.equityLamports),
  peakEquitySol: lamportsToSol(v.peakEquityLamports),
  drawdownPct: v.drawdownPct,
  nextBuySol: lamportsToSol(v.nextBuyLamports),
  minViableBuySol: lamportsToSol(v.minViableBuyLamports),
  revivalSol: lamportsToSol(v.revivalLamports),
  runwayTrades: v.runwayTrades,
})

/** Wires feeds, strategy, risk and execution together. */
export class Engine extends EventEmitter<{
  event: [EngineEvent]
  dead: [Vitals]
  /** Something the owner should hear about even when nobody watches the dashboard. */
  alert: [string]
  feed: [string, boolean]
  /** A finished position's booked P&L was corrected by the exact on-chain amount. */
  reconciled: [Position, bigint]
}> {
  readonly rpc: RpcClient
  readonly protocol: PumpProtocol
  readonly market: MarketBook
  readonly risk: RiskManager
  readonly survival: Survival
  readonly costs: OperatingCosts
  readonly positions: PositionManager
  readonly executor: Executor
  readonly recorder?: LaunchRecorder
  readonly tuner?: AutoTuner
  /** Smart money: early-buy history per wallet, from the recordings (see learning/wallets.ts). */
  readonly wallets = new WalletBook()
  private walletsLoading?: Set<string>
  private smartCache = { at: 0, count: 0 }
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
  /** When the last wallet balance request was sent (live mode). */
  private balanceAt = 0
  private vitals?: Vitals
  private timers: NodeJS.Timeout[] = []
  private readonly startedAt = Date.now()
  private readonly feedProblemAt = new Map<string, number>()
  /** Alerts raised before anyone listened (while starting), kept for the notifier. */
  private readonly earlyAlerts: string[] = []
  /**
   * Positions closed, and corrections booked, before the notifier listened
   * (while settling restored positions on-chain), kept until it takes them.
   */
  private earlyClosed: Position[] | undefined = []
  private earlyReconciled: [Position, bigint][] | undefined = []
  private stopping = false
  /** Fingerprint of the strategy settings, recomputed only when the tuner changes them. */
  private settingsFp = { version: -1, value: '' }

  constructor(
    readonly cfg: Config,
    private readonly wallet: Keypair | undefined,
    private readonly log: Logger,
    private readonly opts: { drainMs?: number; retryMs?: number } = {},
  ) {
    super()
    this.rpc = new RpcClient(cfg.rpcUrl)
    this.protocol = new PumpProtocol(this.rpc, log)
    this.market = new MarketBook(this.protocol)
    this.risk = new RiskManager(cfg, join(cfg.dataDir, `risk-${cfg.dryRun ? 'paper' : 'live'}.json`), (err) => log.warn({ err }, 'failed to persist risk state'))
    this.risk.on('alert', (m) => this.alert(m))
    this.survival = new Survival(cfg, log)
    this.costs = new OperatingCosts(cfg, log)
    // Paper fills need no blockhash; polling one every second would only burn RPC credits.
    this.blockhash = new BlockhashCache(this.rpc, log, cfg.dryRun && !cfg.simulateDryRun ? 60_000 : 1_000)
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
      retryMs: opts.retryMs,
      log,
    })
    // Subscribed before start: settling restored positions can already close
    // some (a sell that landed while the bot was down) or raise alerts.
    this.positions.on('alert', (m) => this.alert(m))
    this.positions.on('update', (p) => this.emit('event', { type: 'position', data: p }))
    this.positions.on('closed', (p) => {
      this.survival.bookClosed(p)
      this.costs.bookClosed(p)
      this.recorder?.position(p)
      this.emit('event', { type: 'closed', data: p })
      if (this.earlyClosed && this.earlyClosed.length < 100) this.earlyClosed.push(p)
      if (!cfg.dryRun) void this.refreshBalance()
    })
    this.positions.on('reconciled', (p, correction) => {
      this.costs.bookCorrection(correction)
      this.emit('reconciled', p, correction)
      if (this.earlyReconciled && this.earlyReconciled.length < 100) this.earlyReconciled.push([p, correction])
    })

    if (cfg.recorder.enabled) {
      this.recorder = new LaunchRecorder(
        {
          dataDir: cfg.dataDir,
          horizonMs: cfg.recorder.horizonMs,
          maxTrades: cfg.recorder.maxTrades,
          ignoreWallets: [this.executor.walletAddress.toBase58()],
          onWallets: (e) => {
            this.wallets.add(e)
            this.walletsLoading?.add(e.mint)
          },
        },
        log,
      )
    }
    // Built before anything can change cfg, so it captures the .env settings.
    if (cfg.autotune.mode !== 'off' || cfg.autotune.requireEdge) {
      this.tuner = new AutoTuner(cfg, log, { costPerDayLamports: () => (this.costs.enabled ? this.costs.perDayLamports() : 0) })
    }

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

    // Pauses and the daily loss limit hold from the first launch on.
    await this.risk.load()
    await this.survival.load()
    await this.costs.load()
    // Tuned settings (paper autotune) are in place before the first launch.
    await this.tuner?.load()
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
    void this.loadWallets()
    await this.positions.start()
    if (!cfg.dryRun) await this.refreshBalance()

    // A bot that died earlier only comes back if it can fund a viable trade again.
    this.survival.reviveOrThrow(this.survivalInput())
    this.survival.onDeath((v) => this.onDeath(v))
    this.vitals = this.survival.check({ ...this.survivalInput(), busy: false })
    log.info(lamportsView(this.vitals), 'vitals')

    this.market.on('launch', (l, s) => this.onLaunch(l, s))
    this.market.on('trade', (state, trade) => this.onTrade(state, trade))
    this.market.on('complete', (state) => {
      this.recorder?.complete(state.mintStr)
      this.positions.onMarket(state)
    })
    this.market.on('migration', (state) => this.positions.onMarket(state))

    for (const feed of this.feeds) {
      feed.on('tx', (tx) => this.onFeedTx(tx))
      feed.on('preview', (p) => this.market.ingestPreview(p))
      feed.on('problem', (message) => {
        this.notice('warn', `${feed.name} feed: ${message}`)
        // At most one push per feed every 30 minutes: a dead stream would otherwise repeat this.
        const last = this.feedProblemAt.get(feed.name) ?? 0
        if (Date.now() - last < 30 * 60_000) return
        this.feedProblemAt.set(feed.name, Date.now())
        this.alert(`⚠️ ${feed.name} feed: ${message}`)
      })
      feed.on('status', (up) => {
        this.notice(up ? 'info' : 'warn', `${feed.name} feed ${up ? 'connected' : 'disconnected'}`)
        this.emit('feed', feed.name, up)
      })
      await feed.start()
    }

    this.timers.push(
      setInterval(() => this.evaluateMomentum(), 250),
      setInterval(() => this.checkVitals(), 1_000),
      setInterval(() => this.market.prune(Math.max(30 * 60_000, cfg.recorder.horizonMs + 60_000)), 60_000),
    )
    if (this.recorder) {
      const recorder = this.recorder
      this.timers.push(setInterval(() => recorder.tick(), 1_000))
    }
    if (!cfg.dryRun) this.timers.push(setInterval(() => void this.refreshBalance(), 15_000))
    if (this.costs.enabled) {
      this.costs.start()
      this.timers.push(setInterval(() => {
        this.costs.accrue()
        void this.costs.persist()
      }, 60_000))
    }
    if (this.tuner) {
      this.tuner.on('notice', (level, message) => {
        this.notice(level, message)
        this.alert(message)
      })
      this.tuner.start()
    }
    log.info('engine running')
  }

  /**
   * Stops without losing track of money: no new buys, then transactions in
   * flight get a few seconds to land (feeds and the tracker still run, so
   * their outcome is seen). Whatever is still in flight after that is saved
   * as pending and settled on-chain at the next start, never booked as failed.
   */
  async stop(): Promise<void> {
    this.stopping = true
    for (const t of this.timers) clearInterval(t)
    this.momentum.clear()
    await this.tuner?.stop()
    await this.positions.drain(this.opts.drainMs ?? DRAIN_MS)
    this.tracker.stop()
    await this.positions.stop()
    for (const f of this.feeds) f.stop()
    this.fees.stop()
    this.lander?.stop()
    this.blockhash.stop()
    this.protocol.stop()
    await this.risk.flush()
    await this.creators.flush()
    await this.recorder?.flush()
    await this.survival.flush()
    await this.costs.stop()
  }

  /** Alerts raised while starting, before a notifier listened; each is handed out once. */
  takeEarlyAlerts(): string[] {
    return this.earlyAlerts.splice(0)
  }

  /**
   * Positions closed before a notifier listened, and the corrections booked
   * meanwhile; handed out once, after which nothing more is kept.
   */
  takeEarlyClosed(): { closed: Position[]; reconciled: [Position, bigint][] } {
    const out = { closed: this.earlyClosed ?? [], reconciled: this.earlyReconciled ?? [] }
    this.earlyClosed = undefined
    this.earlyReconciled = undefined
    return out
  }

  // Stream handling -----------------------------------------------------------

  private onFeedTx(tx: FeedTx): void {
    this.counters.txs++
    // Order matters: capture our own fill before the tracker resolves the outcome.
    this.executor.onFeedTx(tx)
    this.tracker.observe(tx.signature, tx.err, tx.slot)
    this.market.ingest(tx)
  }

  private onTrade(state: MintState, trade: TradeEvent): void {
    this.recorder?.trade(trade)
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
      this.recordLaunch(view, launch, creatorLaunches)
      this.log.debug({ mint: launch.mintStr, symbol: launch.symbol, reason: verdict.reason }, 'launch rejected')
      return
    }

    if (this.cfg.entryMode === 'momentum') {
      view.verdict = 'watching'
      view.reason = 'waiting for momentum'
      this.recordLaunch(view, launch, creatorLaunches)
      this.momentum.set(launch.mintStr, { launch, state })
      return
    }

    view.verdict = 'buying'
    view.reason = 'instant snipe'
    this.recordLaunch(view, launch, creatorLaunches)
    this.latency.decide.add(nowMs() - decideStart)
    void this.enter(launch, state, 'instant snipe')
  }

  private evaluateMomentum(): void {
    for (const [mint, w] of this.momentum) this.checkMomentum(mint, w.launch, w.state)
  }

  private checkMomentum(mint: string, launch: Launch, state: MintState): void {
    const d = decideMomentum(momentumSnapshot(state, launch, Date.now(), (w) => this.wallets.isSmart(w)), this.cfg.momentum, this.cfg.filters.maxEntryMcapLamports)
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
    if (this.stopping || this.entering.has(mint) || this.positions.has(mint)) return
    // No proven edge yet: watch and record, don't spend.
    const gate = this.tuner?.tradingGate()
    if (gate && !gate.allowed) {
      this.updateLaunch(mint, 'skipped', `observing: ${gate.reason}`)
      return
    }
    this.entering.add(mint)
    try {
      if (this.cfg.filters.requireSocials) {
        const meta = await this.metadata.fetch(launch.uri, this.cfg.filters.metadataTimeoutMs)
        if (!hasSocials(meta)) {
          this.updateLaunch(mint, 'rejected', meta ? 'no socials in metadata' : 'metadata unavailable')
          return
        }
      }

      if (this.stopping) return
      // No await between these checks and positions.open() registering the
      // position, so concurrent launches cannot overshoot the limits.
      const vitals = this.survival.compute(this.survivalInput())
      if (this.survival.isDead || vitals.nextBuyLamports === 0n) {
        this.updateLaunch(mint, 'skipped', `survival: ${this.survival.deathReason ?? vitals.reason}`)
        return
      }
      const risk = this.risk.canBuy({ openPositions: this.positions.openCount })
      if (!risk.pass) {
        this.updateLaunch(mint, 'skipped', risk.reason)
        return
      }

      // Live autotune: new settings trade smaller until their probation is over.
      const factor = this.tuner?.sizeFactor() ?? 1
      let lamports = vitals.nextBuyLamports
      if (factor < 1) {
        const reduced = (lamports * BigInt(Math.round(factor * 100))) / 100n
        lamports = reduced > vitals.minViableBuyLamports ? reduced : vitals.minViableBuyLamports
      }
      const sendStart = nowMs()
      this.counters.entries++
      const pos = await this.positions.open({
        mint: launch.mint,
        tokenProgram: launch.tokenProgram,
        creator: state.curve.creator,
        isMayhemMode: launch.isMayhemMode,
        curve: state.curve,
        lamports,
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
      if (!this.cfg.dryRun) void this.refreshBalance()
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
    if (this.stopping) throw new Error('shutting down')
    // Reserved before the first await: a double click, or the bot buying the same coin meanwhile, cannot buy it twice.
    if (this.positions.has(mintStr) || this.entering.has(mintStr)) throw new Error('already holding or buying this coin')
    this.entering.add(mintStr)
    try {
      return await this.manualBuyReserved(mint, mintStr, sol)
    } finally {
      this.entering.delete(mintStr)
    }
  }

  private async manualBuyReserved(mint: PublicKey, mintStr: string, sol?: number): Promise<Position> {
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
    const vitals = this.survival.compute(this.survivalInput())
    if (this.survival.isDead) throw new Error(`bot is dead: ${this.survival.deathReason}`)
    const lamports = sol ? BigInt(Math.round(sol * 1e9)) : vitals.nextBuyLamports
    if (lamports === 0n) throw new Error(`survival: ${vitals.reason}`)
    if (lamports > vitals.affordableLamports) {
      throw new Error(`insufficient funds: at most ${lamportsToSol(vitals.affordableLamports).toFixed(4)} SOL can be spent`)
    }
    const risk = this.risk.canBuy({ openPositions: this.positions.openCount })
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
    const vitals = this.vitals ?? this.survival.compute(this.survivalInput())
    return {
      mode: this.cfg.dryRun ? 'paper' : 'live',
      wallet: this.executor.walletAddress.toBase58(),
      balanceSol: vitals.balanceLamports === null ? null : lamportsToSol(vitals.balanceLamports),
      survival: lamportsView(vitals),
      recorder: this.recorder?.stats() ?? null,
      usage: this.usage(),
      wallets: this.walletStats(),
      costs: this.costs.enabled ? this.costs.status() : null,
      tuning: this.tuner?.status() ?? { mode: 'off' as const },
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

  /**
   * Builds the smart-money book from the logged early buys of the last
   * WALLET_HISTORY_DAYS, in the background: until it is loaded, no wallet
   * counts as smart. Launches that finish meanwhile are added live, once.
   */
  private async loadWallets(): Promise<void> {
    this.walletsLoading = new Set()
    try {
      const from = new Date(Date.now() - SMART_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10)
      const entries = await readWalletEntries(this.cfg.dataDir, from)
      for (const e of entries) if (!this.walletsLoading.has(e.mint)) this.wallets.add(e)
      this.wallets.prune(Date.now())
      this.log.info({ wallets: this.wallets.size, smart: this.wallets.smartCount(), baseRate: this.wallets.baseRate.toFixed(3) }, 'smart-money book loaded')
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'could not load the smart-money book')
    } finally {
      this.walletsLoading = undefined
      this.smartCache.at = 0
    }
  }

  /** For the dashboard and Telegram; counting smart wallets walks the whole book, so at most once a minute. */
  walletStats() {
    if (Date.now() - this.smartCache.at > 60_000) this.smartCache = { at: Date.now(), count: this.wallets.smartCount() }
    return { tracked: this.wallets.size, smart: this.smartCache.count, baseRate: this.wallets.baseRate }
  }

  /**
   * Data and request volume since start, extrapolated per day: what a metered
   * RPC provider bills. Helius: ~20 credits per streamed MB, ~1 per request.
   */
  usage() {
    const days = Math.max((Date.now() - this.startedAt) / 86_400_000, 1 / 1440)
    const bytes = this.feeds.reduce((n, f) => n + (f.stats().bytes ?? 0), 0)
    const mb = bytes / 1_048_576
    const calls = this.rpc.calls
    const helius = /helius/i.test(this.cfg.rpcUrl) || /helius/i.test(this.cfg.wsUrl)
    return {
      streamedMb: mb,
      streamedMbPerDay: mb / days,
      rpcCalls: calls,
      rpcCallsPerDay: calls / days,
      heliusCreditsPerDay: helius ? Math.round((mb / days) * 20 + calls / days) : null,
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
    const sentAt = Date.now()
    try {
      // `processed` so a fill we just saw on the stream is already reflected.
      this.balance = await this.rpc.getBalance(this.executor.walletAddress, 'processed')
      this.balanceAt = sentAt
    } catch (err) {
      this.log.debug({ err: (err as Error).message }, 'balance refresh failed')
    }
  }

  /**
   * Survival inputs. Live: the last wallet balance minus buys it cannot
   * reflect yet (in flight, or filled after the balance was read).
   * Paper: the paper wallet is derived from the positions themselves.
   */
  private survivalInput() {
    const open = this.positions.list()
    let wallet = this.balance
    if (wallet !== null && !this.cfg.dryRun) {
      for (const p of open) {
        if (p.status === 'opening' || (p.filledAt ?? 0) > this.balanceAt) wallet -= p.costLamports
      }
    }
    return { walletLamports: wallet, open }
  }

  private checkVitals(): void {
    const busy =
      this.entering.size > 0 ||
      this.tracker.size > 0 ||
      this.positions.list().some((p) => p.status === 'opening' || p.status === 'closing')
    const prev = this.vitals?.state
    this.vitals = this.survival.check({ ...this.survivalInput(), busy })
    if (prev && prev !== this.vitals.state && this.vitals.state !== 'dead') {
      this.notice(this.vitals.state === 'healthy' ? 'info' : 'warn', `vitals: ${this.vitals.state} (${this.vitals.reason})`)
      this.alert(`vitals ${prev} → ${this.vitals.state}: ${this.vitals.reason}`)
      this.log.warn(lamportsView(this.vitals), 'vitals changed')
    }
  }

  private onDeath(v: Vitals): void {
    this.vitals = v
    this.risk.pause(`dead: ${v.reason}`)
    this.momentum.clear()
    this.notice('error', `bot died: ${v.reason}`)
    this.alert(`bot died: ${v.reason}`)
    this.emit('dead', v)
  }

  private recordLaunch(view: LaunchView, launch: Launch, creatorLaunches: number): void {
    this.launches.unshift(view)
    if (this.launches.length > 300) this.launches.pop()
    this.emit('event', { type: 'launch', data: view })
    if (!this.recorder) return
    const g = this.protocol.global
    const rates = feeRates(this.protocol.feeContext(), launch.curve)
    this.recorder.start(launch, {
      verdict: view.verdict,
      reason: view.reason,
      creatorLaunches,
      feeBps: { protocol: rates.protocolBps, creator: rates.creatorBps },
      tokenOffset: g ? g.initialVirtualTokenReserves - g.initialRealTokenReserves : 279_900_000_000_000n,
      initialRealTokenReserves: this.protocol.initialRealTokenReserves,
      settings: this.settingsFingerprint(),
    })
  }

  private settingsFingerprint(): string {
    const version = this.tuner?.settingsVersion ?? 0
    if (version !== this.settingsFp.version) this.settingsFp = { version, value: settingsFingerprint(paramsFromConfig(this.cfg)) }
    return this.settingsFp.value
  }

  private updateLaunch(mint: string, verdict: LaunchView['verdict'], reason: string): void {
    this.recorder?.verdict(mint, verdict, reason)
    const view = this.launches.find((l) => l.mint === mint)
    if (view) {
      view.verdict = verdict
      view.reason = reason
    }
    this.emit('event', { type: 'launch-update', data: { mint, verdict, reason } })
  }

  private alert(message: string): void {
    if (this.listenerCount('alert') > 0) this.emit('alert', message)
    else if (this.earlyAlerts.length < 20) this.earlyAlerts.push(message)
  }

  private notice(level: 'info' | 'warn' | 'error', message: string): void {
    this.emit('event', { type: 'notice', data: { level, message, at: Date.now() } })
  }
}
