import { z } from 'zod'

// Env parsing helpers -----------------------------------------------------------

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return def
      const s = v.trim().toLowerCase()
      if (['1', 'true', 'yes', 'on'].includes(s)) return true
      if (['0', 'false', 'no', 'off'].includes(s)) return false
      ctx.addIssue({ code: 'custom', message: `expected a boolean, got "${v}"` })
      return z.NEVER
    })

const num = (def: number, opts: { min?: number; max?: number; int?: boolean } = {}) => {
  let s = z.coerce.number()
  if (opts.int) s = s.int()
  if (opts.min !== undefined) s = s.min(opts.min)
  if (opts.max !== undefined) s = s.max(opts.max)
  return z.preprocess((v) => (v === undefined || v === '' ? def : v), s)
}

const csv = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []))

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined))

const regex = optionalString.transform((v, ctx) => {
  if (!v) return undefined
  try {
    return new RegExp(v, 'i')
  } catch (e) {
    ctx.addIssue({ code: 'custom', message: `invalid regex: ${(e as Error).message}` })
    return z.NEVER
  }
})

/** `"50:40,120:100"` → sell 40% of the remaining position at +50%, the rest at +120%. */
const takeProfit = z
  .string()
  .optional()
  .transform((v, ctx) => {
    const raw = v === undefined ? '60:50,150:100' : v
    if (raw.trim() === '' || raw.trim() === '0') return []
    const tiers: { gainPct: number; sellPct: number }[] = []
    for (const part of raw.split(',')) {
      const [g, s] = part.split(':').map((x) => Number(x.trim()))
      if (g === undefined || s === undefined || !Number.isFinite(g) || !Number.isFinite(s) || g <= 0 || s <= 0 || s > 100) {
        ctx.addIssue({ code: 'custom', message: `invalid take-profit tier "${part}" (expected gainPct:sellPct)` })
        return z.NEVER
      }
      tiers.push({ gainPct: g, sellPct: s })
    }
    return tiers.sort((a, b) => a.gainPct - b.gainPct)
  })

const schema = z.object({
  // Connectivity
  RPC_URL: z.url({ message: 'RPC_URL must be an http(s) URL' }),
  WS_URL: optionalString,
  SEND_RPC_URLS: csv,
  GRPC_URL: optionalString,
  GRPC_TOKEN: optionalString,
  GRPC_DESHRED: bool(false),
  FEED: z.enum(['auto', 'ws', 'grpc']).default('auto'),

  // Wallet
  PRIVATE_KEY: optionalString,
  KEYPAIR_PATH: optionalString,

  // Mode
  DRY_RUN: bool(true),
  SIMULATE_DRY_RUN: bool(false),
  PAPER_LATENCY_MS: num(350, { min: 0, max: 10_000, int: true }),

  // Landing
  LANDING: z.enum(['auto', 'helius', 'jito', 'rpc']).default('auto'),
  HELIUS_SENDER_URL: z.string().default('https://sender.helius-rpc.com/fast'),
  HELIUS_SWQOS_ONLY: bool(false),
  JITO_BLOCK_ENGINE_URLS: csv,
  JITO_AUTH_UUID: optionalString,
  TIP_SOL: num(0.001, { min: 0, max: 1 }),
  SELL_TIP_SOL: num(-1, { min: -1, max: 1 }),
  PRIORITY_FEE_MODE: z.enum(['fixed', 'dynamic']).default('fixed'),
  PRIORITY_FEE_SOL: num(0.0005, { min: 0, max: 1 }),
  SELL_PRIORITY_FEE_SOL: num(0.0003, { min: 0, max: 1 }),
  PRIORITY_FEE_MAX_SOL: num(0.005, { min: 0, max: 1 }),
  PRIORITY_FEE_PERCENTILE: num(75, { min: 1, max: 100, int: true }),
  BUY_COMPUTE_UNITS: num(180_000, { min: 30_000, max: 1_400_000, int: true }),
  SELL_COMPUTE_UNITS: num(150_000, { min: 30_000, max: 1_400_000, int: true }),
  REBROADCAST_INTERVAL_MS: num(400, { min: 100, max: 5_000, int: true }),
  REBROADCAST_MAX: num(8, { min: 0, max: 100, int: true }),

  // Entry
  BUY_SOL: num(0.05, { min: 0.0001, max: 1000 }),
  BUY_SLIPPAGE_BPS: num(2_000, { min: 0, max: 9_900, int: true }),
  ENTRY_MODE: z.enum(['instant', 'momentum']).default('instant'),
  MOMENTUM_MIN_AGE_MS: num(1_500, { min: 0, int: true }),
  MOMENTUM_MAX_AGE_MS: num(15_000, { min: 100, int: true }),
  MOMENTUM_MIN_BUYERS: num(6, { min: 0, int: true }),
  MOMENTUM_MIN_NET_BUY_SOL: num(2, { min: 0 }),
  MOMENTUM_MAX_SELL_RATIO: num(0.4, { min: 0, max: 10 }),
  MOMENTUM_MAX_EARLY_BUY_SOL: num(0, { min: 0 }),
  MOMENTUM_MAX_TOP_BUYER_PCT: num(0, { min: 0, max: 100 }),

  // Filters
  ALLOW_MAYHEM: bool(false),
  ALLOW_HOLDER_REWARD: bool(true),
  REQUIRE_URI: bool(true),
  NAME_BLOCKLIST: regex,
  NAME_ALLOWLIST: regex,
  DEV_BUY_MIN_SOL: num(0, { min: 0 }),
  DEV_BUY_MAX_SOL: num(5, { min: 0 }),
  DEV_MAX_SUPPLY_PCT: num(15, { min: 0, max: 100 }),
  MAX_ENTRY_MCAP_SOL: num(80, { min: 0 }),
  MAX_CURVE_PROGRESS_PCT: num(35, { min: 0, max: 100 }),
  CREATOR_MAX_LAUNCHES: num(2, { min: 1, int: true }),
  CREATOR_WINDOW_MINUTES: num(1_440, { min: 1, int: true }),
  CREATOR_BLOCKLIST: csv,
  CREATOR_ALLOWLIST: csv,
  CREATOR_ALLOWLIST_ONLY: bool(false),
  REQUIRE_SOCIALS: bool(false),
  METADATA_TIMEOUT_MS: num(800, { min: 50, max: 10_000, int: true }),

  // Exits
  TAKE_PROFIT: takeProfit,
  STOP_LOSS_PCT: num(25, { min: 0, max: 100 }),
  TRAILING_STOP_PCT: num(20, { min: 0, max: 100 }),
  TRAILING_ARM_PCT: num(30, { min: 0 }),
  MAX_HOLD_SECONDS: num(180, { min: 0, int: true }),
  STALE_SECONDS: num(45, { min: 0, int: true }),
  EXIT_ON_DEV_SELL: bool(true),
  MOONBAG_PCT: num(0, { min: 0, max: 90 }),
  MOONBAG_SECURE_PCT: num(10, { min: 0, max: 500 }),
  MOONBAG_STOP_BUFFER_PCT: num(5, { min: 0, max: 100 }),
  MOONBAG_TRAILING_PCT: num(40, { min: 0, max: 100 }),
  MOONBAG_STALE_SECONDS: num(1_800, { min: 0, int: true }),
  MOONBAG_MAX_HOLD_SECONDS: num(0, { min: 0, int: true }),
  MAX_MOONBAGS: num(10, { min: 0, int: true }),
  SELL_SLIPPAGE_BPS: num(2_500, { min: 0, max: 9_900, int: true }),
  SELL_MAX_SLIPPAGE_BPS: num(6_000, { min: 0, max: 10_000, int: true }),
  SELL_RETRIES: num(3, { min: 0, max: 20, int: true }),
  CLOSE_TOKEN_ACCOUNT: bool(true),

  // Survival
  PAPER_START_SOL: num(1, { min: 0.001, max: 1_000_000 }),
  PAPER_RESET: bool(false),
  SIZING: z.enum(['fixed', 'fraction']).default('fixed'),
  BUY_FRACTION_PCT: num(5, { min: 0.1, max: 100 }),
  MIN_BUY_SOL: num(0.02, { min: 0.0001, max: 1000 }),
  MAX_FEE_DRAG_PCT: num(10, { min: 0.1, max: 100 }),
  DEFENSIVE_DRAWDOWN_PCT: num(30, { min: 0, max: 100 }),
  SURVIVAL_SHUTDOWN: bool(true),

  // Learning data
  RECORD_LAUNCHES: bool(true),
  RECORD_HORIZON_MIN: num(15, { min: 0.001, max: 240 }),
  RECORD_MAX_TRADES: num(800, { min: 10, max: 100_000, int: true }),

  // Autotuning
  AUTOTUNE: z.enum(['auto', 'off', 'suggest', 'paper', 'live']).default('auto'),
  AUTOTUNE_INTERVAL_HOURS: num(6, { min: 0.001, max: 168 }),
  AUTOTUNE_DAYS: num(7, { min: 1, max: 90, int: true }),
  AUTOTUNE_MAX_LAUNCHES: num(30_000, { min: 100, max: 1_000_000, int: true }),
  AUTOTUNE_MIN_LAUNCHES: num(2_000, { min: 10, int: true }),
  AUTOTUNE_MIN_HOURS: num(24, { min: 0, max: 2_000 }),
  AUTOTUNE_MIN_TRADES: num(60, { min: 5, int: true }),
  AUTOTUNE_MIN_EDGE_PCT: num(1, { min: 0, max: 100 }),
  AUTOTUNE_MAX_CHANGES: num(3, { min: 1, max: 11, int: true }),
  AUTOTUNE_PROBATION_TRADES: num(30, { min: 1, int: true }),
  AUTOTUNE_COOLDOWN_HOURS: num(24, { min: 0, max: 720 }),
  REQUIRE_EDGE: z.enum(['auto', 'true', 'false']).default('auto'),
  LIVE_PROBATION_SIZE_PCT: num(50, { min: 10, max: 100 }),

  // Cost of existence
  OPERATING_COST_PER_MONTH: num(0, { min: 0 }),
  OPERATING_COST_CURRENCY: z.enum(['usd', 'eur', 'sol']).default('usd'),

  // Risk
  MAX_OPEN_POSITIONS: num(3, { min: 1, int: true }),
  MAX_BUYS_PER_MINUTE: num(6, { min: 1, int: true }),
  DAILY_LOSS_LIMIT_SOL: num(0, { min: 0 }),
  MIN_SOL_RESERVE: num(0.02, { min: 0 }),

  // API / ops
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: num(8787, { min: 0, max: 65_535, int: true }),
  API_TOKEN: optionalString,
  DATA_DIR: z.string().default('./data'),

  // Notifications
  TELEGRAM_BOT_TOKEN: optionalString,
  TELEGRAM_CHAT_ID: optionalString,
  TELEGRAM_API_URL: z.string().url().default('https://api.telegram.org'),
  NOTIFY_TRADES: bool(false),
  NOTIFY_DAILY_HOUR_UTC: num(7, { min: -1, max: 23, int: true }),
  NOTIFY_DIGEST_HOURS: num(6, { min: 0, max: 24, int: true }),
  NOTIFY_HIGHLIGHTS: bool(true),
  NOTIFY_COMMANDS: bool(true),
  NOTIFY_TIMEZONE: z.string().default('Europe/Amsterdam'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
})

export type Env = z.infer<typeof schema>

const LAMPORTS = 1_000_000_000
export const solToLamports = (sol: number): bigint => BigInt(Math.round(sol * LAMPORTS))
export const lamportsToSol = (lamports: bigint | number): number => Number(lamports) / LAMPORTS

export type Landing = 'helius' | 'jito' | 'rpc'

export interface Config {
  rpcUrl: string
  wsUrl: string
  sendRpcUrls: string[]
  feed: 'ws' | 'grpc'
  grpc?: { url: string; token?: string; deshred: boolean }
  privateKey?: string
  keypairPath?: string

  dryRun: boolean
  simulateDryRun: boolean
  paperLatencyMs: number

  landing: Landing
  heliusSenderUrl: string
  heliusSwqosOnly: boolean
  jitoUrls: string[]
  jitoAuthUuid?: string
  buyTipLamports: bigint
  sellTipLamports: bigint
  priorityFeeMode: 'fixed' | 'dynamic'
  buyPriorityLamports: bigint
  sellPriorityLamports: bigint
  maxPriorityLamports: bigint
  priorityFeePercentile: number
  buyComputeUnits: number
  sellComputeUnits: number
  rebroadcastIntervalMs: number
  rebroadcastMax: number

  buyLamports: bigint
  buySlippageBps: number
  entryMode: 'instant' | 'momentum'
  momentum: {
    minAgeMs: number
    maxAgeMs: number
    minBuyers: number
    minNetBuyLamports: bigint
    maxSellRatio: number
    /** Skip coins where other wallets bought more than this in the first 0.5s (bundled insiders). 0 = off. */
    maxEarlyBuyLamports: bigint
    /** Skip coins where one wallet (not the dev) holds more than this % of the supply. 0 = off. */
    maxTopBuyerPct: number
  }

  filters: {
    allowMayhem: boolean
    allowHolderReward: boolean
    requireUri: boolean
    nameBlocklist?: RegExp
    nameAllowlist?: RegExp
    devBuyMinLamports: bigint
    devBuyMaxLamports: bigint
    devMaxSupplyPct: number
    maxEntryMcapLamports: bigint
    maxCurveProgressPct: number
    creatorMaxLaunches: number
    creatorWindowMs: number
    creatorBlocklist: Set<string>
    creatorAllowlist: Set<string>
    creatorAllowlistOnly: boolean
    requireSocials: boolean
    metadataTimeoutMs: number
  }

  exits: {
    takeProfit: { gainPct: number; sellPct: number }[]
    stopLossPct: number
    trailingStopPct: number
    trailingArmPct: number
    maxHoldMs: number
    staleMs: number
    exitOnDevSell: boolean
    /**
     * Free ride: once selling all but `pct`% of the bought tokens returns the
     * stake, every fee and `securePct`% profit, sell that and let the rest run
     * under its own rules. `pct` 0 = off.
     */
    moonbag: {
      pct: number
      securePct: number
      /** The moonbag is sold at entry + this % (+ the sell's own network fee). */
      stopBufferPct: number
      /** Sell the moonbag this far off its peak; 0 = off. */
      trailingPct: number
      /** A coin nobody traded for this long is dead, not a runner; 0 = off. */
      staleMs: number
      /** Optional hard limit from the position's opening; 0 = none (the default: a moonbag rides as long as it runs). */
      maxHoldMs: number
      /** Most moonbags held at once (they don't count against MAX_OPEN_POSITIONS). */
      max: number
    }
    sellSlippageBps: number
    sellMaxSlippageBps: number
    sellRetries: number
    closeTokenAccount: boolean
  }

  risk: {
    maxOpenPositions: number
    maxBuysPerMinute: number
    dailyLossLimitLamports: bigint
    minReserveLamports: bigint
  }

  survival: {
    paperStartLamports: bigint
    paperReset: boolean
    /** `fixed`: BUY_SOL per trade. `fraction`: BUY_FRACTION_PCT of free balance, capped at BUY_SOL. */
    sizing: 'fixed' | 'fraction'
    buyFractionPct: number
    minBuyLamports: bigint
    /** Refuse trades whose round-trip network cost exceeds this share of the trade size. */
    maxFeeDragPct: number
    defensiveDrawdownPct: number
    shutdown: boolean
  }

  recorder: { enabled: boolean; horizonMs: number; maxTrades: number }

  autotune: {
    /**
     * off; suggest = propose only; paper = adopt automatically (paper mode
     * only); live = adopt in live mode after a shadow test, at reduced size.
     */
    mode: 'off' | 'suggest' | 'paper' | 'live'
    intervalMs: number
    days: number
    maxLaunches: number
    minLaunches: number
    minHours: number
    minTrainTrades: number
    minTestTrades: number
    minEdgePct: number
    maxChanges: number
    probationTrades: number
    cooldownMs: number
    /** Only buy while the settings in effect make money on recent launches. */
    requireEdge: boolean
    /** Live autotune: trade size (% of normal) while new settings are on probation. */
    liveProbationSizePct: number
  }

  /** What running the bot costs (RPC plan, server); it has to earn at least this. */
  costs: { perMonth: number; currency: 'usd' | 'eur' | 'sol' }

  notify: {
    telegram?: { token: string; chatId: string; apiUrl: string }
    /** Also report every closed trade. */
    trades: boolean
    /** UTC hour of the daily summary; -1 disables it. */
    dailyHourUtc: number
    /** A digest every this many hours, on the local clock (0, 6, 12, 18 for 6); 0 = off. */
    digestHours: number
    /** Free rides, moonbags at 3x/5x/10x..., new equity records. */
    highlights: boolean
    /** Answer /status, /pauze and the other commands from the configured chat. */
    commands: boolean
    /** IANA time zone for "today" and the digest clock. */
    timeZone: string
  }

  api: { host: string; port: number; token?: string }
  dataDir: string
  logLevel: Env['LOG_LEVEL']
}

const DEFAULT_JITO = ['https://mainnet.block-engine.jito.wtf']

export function deriveWsUrl(rpcUrl: string): string {
  const u = new URL(rpcUrl)
  u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:'
  return u.toString()
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Invalid configuration:\n${issues}`)
  }
  const e = parsed.data

  const feed: Config['feed'] = e.FEED === 'auto' ? (e.GRPC_URL ? 'grpc' : 'ws') : e.FEED
  if (feed === 'grpc' && !e.GRPC_URL) throw new Error('FEED=grpc requires GRPC_URL')

  const landing: Landing =
    e.LANDING === 'auto' ? (/helius/i.test(e.RPC_URL) ? 'helius' : 'jito') : e.LANDING

  const buyTip = solToLamports(e.TIP_SOL)
  const heliusMinTip = e.HELIUS_SWQOS_ONLY ? 5_000n : 1_000_000n
  if (landing === 'helius' && buyTip < heliusMinTip) {
    throw new Error(`Helius Sender requires TIP_SOL >= ${lamportsToSol(heliusMinTip)} (set HELIUS_SWQOS_ONLY=true for the 0.000005 SOL tier)`)
  }
  if (landing === 'jito' && buyTip < 1_000n) throw new Error('Jito requires TIP_SOL >= 0.000001')
  const sellTip = e.SELL_TIP_SOL < 0 ? buyTip : solToLamports(e.SELL_TIP_SOL)

  if (e.SELL_MAX_SLIPPAGE_BPS < e.SELL_SLIPPAGE_BPS) {
    throw new Error('SELL_MAX_SLIPPAGE_BPS must be >= SELL_SLIPPAGE_BPS')
  }
  if (e.MOMENTUM_MAX_AGE_MS <= e.MOMENTUM_MIN_AGE_MS) {
    throw new Error('MOMENTUM_MAX_AGE_MS must be greater than MOMENTUM_MIN_AGE_MS')
  }
  if (e.MIN_BUY_SOL > e.BUY_SOL) throw new Error('MIN_BUY_SOL must be <= BUY_SOL')
  if (e.NOTIFY_DIGEST_HOURS > 0 && 24 % e.NOTIFY_DIGEST_HOURS !== 0) {
    throw new Error('NOTIFY_DIGEST_HOURS must divide the day evenly: 1, 2, 3, 4, 6, 8, 12 or 24 (0 = off)')
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: e.NOTIFY_TIMEZONE })
  } catch {
    throw new Error(`NOTIFY_TIMEZONE: unknown time zone "${e.NOTIFY_TIMEZONE}" (e.g. Europe/Amsterdam)`)
  }
  if (e.AUTOTUNE === 'paper' && !e.DRY_RUN) {
    throw new Error('AUTOTUNE=paper only works in paper mode (DRY_RUN=true); use AUTOTUNE=suggest for proposals in live mode')
  }
  if (e.AUTOTUNE !== 'off' && e.AUTOTUNE !== 'auto' && !e.RECORD_LAUNCHES) {
    throw new Error('AUTOTUNE needs RECORD_LAUNCHES=true: it learns from recorded launches')
  }
  if (e.AUTOTUNE === 'live' && e.DRY_RUN) {
    throw new Error('AUTOTUNE=live is for live trading (DRY_RUN=false); in paper mode use AUTOTUNE=paper')
  }
  if (e.AUTOTUNE === 'live' && e.REQUIRE_EDGE === 'false') {
    throw new Error('AUTOTUNE=live needs REQUIRE_EDGE: real money is never traded on settings without a proven edge')
  }
  if (e.REQUIRE_EDGE === 'true' && !e.RECORD_LAUNCHES) {
    throw new Error('REQUIRE_EDGE needs RECORD_LAUNCHES=true: the edge is measured on recorded launches')
  }
  if (!e.DRY_RUN && !e.PRIVATE_KEY && !e.KEYPAIR_PATH) {
    throw new Error('Live trading (DRY_RUN=false) requires PRIVATE_KEY or KEYPAIR_PATH')
  }

  return {
    rpcUrl: e.RPC_URL,
    wsUrl: e.WS_URL ?? deriveWsUrl(e.RPC_URL),
    sendRpcUrls: e.SEND_RPC_URLS,
    feed,
    grpc: e.GRPC_URL ? { url: e.GRPC_URL, token: e.GRPC_TOKEN, deshred: e.GRPC_DESHRED } : undefined,
    privateKey: e.PRIVATE_KEY,
    keypairPath: e.KEYPAIR_PATH,

    dryRun: e.DRY_RUN,
    simulateDryRun: e.SIMULATE_DRY_RUN,
    paperLatencyMs: e.PAPER_LATENCY_MS,

    landing,
    heliusSenderUrl: e.HELIUS_SENDER_URL,
    heliusSwqosOnly: e.HELIUS_SWQOS_ONLY,
    jitoUrls: e.JITO_BLOCK_ENGINE_URLS.length ? e.JITO_BLOCK_ENGINE_URLS : DEFAULT_JITO,
    jitoAuthUuid: e.JITO_AUTH_UUID,
    buyTipLamports: landing === 'rpc' ? 0n : buyTip,
    sellTipLamports: landing === 'rpc' ? 0n : sellTip,
    priorityFeeMode: e.PRIORITY_FEE_MODE,
    buyPriorityLamports: solToLamports(e.PRIORITY_FEE_SOL),
    sellPriorityLamports: solToLamports(e.SELL_PRIORITY_FEE_SOL),
    maxPriorityLamports: solToLamports(e.PRIORITY_FEE_MAX_SOL),
    priorityFeePercentile: e.PRIORITY_FEE_PERCENTILE,
    buyComputeUnits: e.BUY_COMPUTE_UNITS,
    sellComputeUnits: e.SELL_COMPUTE_UNITS,
    rebroadcastIntervalMs: e.REBROADCAST_INTERVAL_MS,
    rebroadcastMax: e.REBROADCAST_MAX,

    buyLamports: solToLamports(e.BUY_SOL),
    buySlippageBps: e.BUY_SLIPPAGE_BPS,
    entryMode: e.ENTRY_MODE,
    momentum: {
      minAgeMs: e.MOMENTUM_MIN_AGE_MS,
      maxAgeMs: e.MOMENTUM_MAX_AGE_MS,
      minBuyers: e.MOMENTUM_MIN_BUYERS,
      minNetBuyLamports: solToLamports(e.MOMENTUM_MIN_NET_BUY_SOL),
      maxSellRatio: e.MOMENTUM_MAX_SELL_RATIO,
      maxEarlyBuyLamports: solToLamports(e.MOMENTUM_MAX_EARLY_BUY_SOL),
      maxTopBuyerPct: e.MOMENTUM_MAX_TOP_BUYER_PCT,
    },

    filters: {
      allowMayhem: e.ALLOW_MAYHEM,
      allowHolderReward: e.ALLOW_HOLDER_REWARD,
      requireUri: e.REQUIRE_URI,
      nameBlocklist: e.NAME_BLOCKLIST,
      nameAllowlist: e.NAME_ALLOWLIST,
      devBuyMinLamports: solToLamports(e.DEV_BUY_MIN_SOL),
      devBuyMaxLamports: solToLamports(e.DEV_BUY_MAX_SOL),
      devMaxSupplyPct: e.DEV_MAX_SUPPLY_PCT,
      maxEntryMcapLamports: solToLamports(e.MAX_ENTRY_MCAP_SOL),
      maxCurveProgressPct: e.MAX_CURVE_PROGRESS_PCT,
      creatorMaxLaunches: e.CREATOR_MAX_LAUNCHES,
      creatorWindowMs: e.CREATOR_WINDOW_MINUTES * 60_000,
      creatorBlocklist: new Set(e.CREATOR_BLOCKLIST),
      creatorAllowlist: new Set(e.CREATOR_ALLOWLIST),
      creatorAllowlistOnly: e.CREATOR_ALLOWLIST_ONLY,
      requireSocials: e.REQUIRE_SOCIALS,
      metadataTimeoutMs: e.METADATA_TIMEOUT_MS,
    },

    exits: {
      takeProfit: e.TAKE_PROFIT,
      stopLossPct: e.STOP_LOSS_PCT,
      trailingStopPct: e.TRAILING_STOP_PCT,
      trailingArmPct: e.TRAILING_ARM_PCT,
      maxHoldMs: e.MAX_HOLD_SECONDS * 1_000,
      staleMs: e.STALE_SECONDS * 1_000,
      exitOnDevSell: e.EXIT_ON_DEV_SELL,
      moonbag: {
        pct: e.MOONBAG_PCT,
        securePct: e.MOONBAG_SECURE_PCT,
        stopBufferPct: e.MOONBAG_STOP_BUFFER_PCT,
        trailingPct: e.MOONBAG_TRAILING_PCT,
        staleMs: e.MOONBAG_STALE_SECONDS * 1_000,
        maxHoldMs: e.MOONBAG_MAX_HOLD_SECONDS * 1_000,
        max: e.MAX_MOONBAGS,
      },
      sellSlippageBps: e.SELL_SLIPPAGE_BPS,
      sellMaxSlippageBps: e.SELL_MAX_SLIPPAGE_BPS,
      sellRetries: e.SELL_RETRIES,
      closeTokenAccount: e.CLOSE_TOKEN_ACCOUNT,
    },

    risk: {
      maxOpenPositions: e.MAX_OPEN_POSITIONS,
      maxBuysPerMinute: e.MAX_BUYS_PER_MINUTE,
      dailyLossLimitLamports: solToLamports(e.DAILY_LOSS_LIMIT_SOL),
      minReserveLamports: solToLamports(e.MIN_SOL_RESERVE),
    },

    survival: {
      paperStartLamports: solToLamports(e.PAPER_START_SOL),
      paperReset: e.PAPER_RESET,
      sizing: e.SIZING,
      buyFractionPct: e.BUY_FRACTION_PCT,
      minBuyLamports: solToLamports(e.MIN_BUY_SOL),
      maxFeeDragPct: e.MAX_FEE_DRAG_PCT,
      defensiveDrawdownPct: e.DEFENSIVE_DRAWDOWN_PCT,
      shutdown: e.SURVIVAL_SHUTDOWN,
    },

    autotune: {
      // Automatic adoption is paper-only; live mode can at most suggest.
      mode: e.AUTOTUNE === 'auto' ? (!e.RECORD_LAUNCHES ? 'off' : e.DRY_RUN ? 'paper' : 'suggest') : e.AUTOTUNE,
      intervalMs: Math.round(e.AUTOTUNE_INTERVAL_HOURS * 3_600_000),
      days: e.AUTOTUNE_DAYS,
      maxLaunches: e.AUTOTUNE_MAX_LAUNCHES,
      minLaunches: e.AUTOTUNE_MIN_LAUNCHES,
      minHours: e.AUTOTUNE_MIN_HOURS,
      minTrainTrades: e.AUTOTUNE_MIN_TRADES,
      minTestTrades: Math.max(5, Math.ceil(e.AUTOTUNE_MIN_TRADES * 0.4)),
      minEdgePct: e.AUTOTUNE_MIN_EDGE_PCT,
      maxChanges: e.AUTOTUNE_MAX_CHANGES,
      probationTrades: e.AUTOTUNE_PROBATION_TRADES,
      cooldownMs: Math.round(e.AUTOTUNE_COOLDOWN_HOURS * 3_600_000),
      requireEdge: e.REQUIRE_EDGE === 'auto' ? e.RECORD_LAUNCHES : e.REQUIRE_EDGE === 'true',
      liveProbationSizePct: e.LIVE_PROBATION_SIZE_PCT,
    },

    recorder: {
      enabled: e.RECORD_LAUNCHES,
      horizonMs: Math.round(e.RECORD_HORIZON_MIN * 60_000),
      maxTrades: e.RECORD_MAX_TRADES,
    },

    costs: { perMonth: e.OPERATING_COST_PER_MONTH, currency: e.OPERATING_COST_CURRENCY },

    notify: {
      telegram: e.TELEGRAM_BOT_TOKEN && e.TELEGRAM_CHAT_ID ? { token: e.TELEGRAM_BOT_TOKEN, chatId: e.TELEGRAM_CHAT_ID, apiUrl: e.TELEGRAM_API_URL } : undefined,
      trades: e.NOTIFY_TRADES,
      dailyHourUtc: e.NOTIFY_DAILY_HOUR_UTC,
      digestHours: e.NOTIFY_DIGEST_HOURS,
      highlights: e.NOTIFY_HIGHLIGHTS,
      commands: e.NOTIFY_COMMANDS,
      timeZone: e.NOTIFY_TIMEZONE,
    },

    api: { host: e.API_HOST, port: e.API_PORT, token: e.API_TOKEN },
    dataDir: e.DATA_DIR,
    logLevel: e.LOG_LEVEL,
  }
}

/** Config with secrets stripped, safe to log or expose on the API. */
export function publicConfig(c: Config) {
  const redact = (u: string) => {
    try {
      const url = new URL(u)
      for (const k of [...url.searchParams.keys()]) url.searchParams.set(k, '***')
      if (url.password) url.password = '***'
      return url.toString()
    } catch {
      return '***'
    }
  }
  const { privateKey: _pk, keypairPath: _kp, api, grpc, ...rest } = c
  return {
    ...rest,
    rpcUrl: redact(c.rpcUrl),
    wsUrl: redact(c.wsUrl),
    sendRpcUrls: c.sendRpcUrls.map(redact),
    grpc: grpc ? { url: redact(grpc.url), deshred: grpc.deshred } : undefined,
    jitoAuthUuid: c.jitoAuthUuid ? '***' : undefined,
    api: { host: api.host, port: api.port, tokenSet: Boolean(api.token) },
    notify: { ...c.notify, telegram: c.notify.telegram ? { configured: true } : undefined },
    filters: {
      ...c.filters,
      nameBlocklist: c.filters.nameBlocklist?.source,
      nameAllowlist: c.filters.nameAllowlist?.source,
      creatorBlocklist: c.filters.creatorBlocklist.size,
      creatorAllowlist: c.filters.creatorAllowlist.size,
    },
  }
}
