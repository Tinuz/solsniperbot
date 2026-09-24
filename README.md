# Sol Sniper

A low-latency [pump.fun](https://pump.fun) sniper for Solana. It detects launches from the program's log stream, decides in microseconds, builds and signs the buy locally, and sends the same signed transaction over several landing paths at once. It then manages each position with take-profit tiers, stop loss, trailing stop, dev-dump detection and time exits.

> **Risk warning.** Memecoin sniping loses money more often than not. Most launches go to zero, many are built to rug snipers, and this software can have bugs. Run it in paper mode first, use a dedicated hot wallet holding only what you can afford to lose, and read the code before trusting it with funds. Nothing here is financial advice.

## Why it is fast

The previous version detected mints through `InitializeMint` logs, randomly dropped 30% of them, re-fetched every transaction over RPC, polled Jupiter every 30 s for a market, and then waited for a human to click through a browser wallet popup. That adds up to seconds or minutes per snipe. This version removes every one of those steps:

```mermaid
flowchart LR
  A[pump program logs<br/>WS or gRPC, processed] -->|decode CreateEvent + dev TradeEvent<br/>0 RPC calls| B[filters<br/>~0.1 ms]
  B --> C[build buy_exact_quote_in_v2<br/>cached blockhash, local signing]
  C --> D{same signed bytes}
  D --> E[Helius Sender / Jito]
  D --> F[RPC + extra RPCs<br/>rebroadcast until landed]
  E & F --> G[own TradeEvent in stream<br/>= confirmation + exact fill]
```

- **Zero round-trips on the hot path.** The create transaction's logs carry the coin's name, creator, token program and the curve's reserves after the dev's buy. The bot decides and prices from those alone. Blockhash, fee config, fee recipients and PDAs are all precomputed or cached.
- **Earliest possible detection.** A websocket `logsSubscribe` works out of the box. Yellowstone gRPC (Triton, Helius LaserStream) adds reconnect with slot backfill. `GRPC_DESHRED=true` goes further and sees launches in shreds, *before* the create transaction has executed; the dev buy is reconstructed from instruction arguments.
- **Multi-path landing with no double-buy risk.** One signed transaction goes to Helius Sender or Jito plus your RPCs at the same time. Because every path carries the same signature, it can only land once. Plain RPCs are rebroadcast every 400 ms until the transaction lands or its blockhash expires. Connections to every path are kept warm.
- **Streaming confirmation.** Your own trade shows up in the same log stream at `processed`. That confirms the transaction and gives the exact tokens and SOL filled, without waiting on a status poll.
- **Streaming prices.** Every pump trade carries the curve's post-trade reserves, so open positions are repriced on every trade, not on a timer.

The dashboard shows the latency you actually get: detect→send percentiles, land time, and how many slots after launch your buy landed.

## Why it is accurate

- **Current protocol.** It uses pump.fun's unified `buy_v2` / `sell_v2` / `buy_exact_quote_in_v2` instructions with Token-2022 mints, the 8+8+8 fee recipient sets from the live `Global` account, market-cap fee tiers from the live `FeeConfig`, holder-reward coins (creator vault = holder-rewards PDA), and mayhem coins.
- **Verified against the official SDK.** The test suite checks that `buy_v2` and `sell_v2` are **byte-identical** to `@pump-fun/pump-sdk` for both token programs. It checks that event and account decoders agree with the SDK and the published IDL. It checks that sell proceeds and exact-token buy costs match the SDK **exactly** over randomized curves.
- **Correct entry pricing.** Quotes use the curve state *after* the dev's buy in the create transaction, and fees are applied at the tier that coin's market cap falls in. `buy_exact_quote_in_v2` spends exactly your `BUY_SOL`, and slippage is enforced on the token output.
- **Exits based on what you can realize.** Gains are measured as what your remaining tokens would fetch if sold right now (curve impact and fees included), not spot price. A thin curve can't trigger a take-profit your sell wouldn't realize.
- **Exact P&L.** Fills come from your own on-chain trade events. In live mode every transaction is then reconciled against your wallet's actual lamport change (tips, priority fees, rent included), and booked P&L is corrected if the estimate was off. Paper P&L deducts estimated tips and fees so it isn't flattered.
- **Realistic paper trading.** Paper fills happen against the live curve after `PAPER_LATENCY_MS`. If others bought in that window and your slippage limit is breached, the paper buy fails, as the real one would. With `SIMULATE_DRY_RUN=true` and a funded wallet, each would-be trade is also run through `simulateTransaction` against the real program.

## Quick start

Requires Node.js ≥ 22.19.

```bash
npm install

# 1. Offline demo: simulated chain + dashboard, no RPC key needed
npm run demo                # open http://localhost:8787

# 2. Paper trading against mainnet
cp .env.example .env        # set RPC_URL (a paid, low-latency RPC)
npm run dev                 # open http://localhost:8787

# 3. Live trading: only after you have watched paper results for a while
#    set DRY_RUN=false and PRIVATE_KEY (or KEYPAIR_PATH) in .env
npm run build && npm start
```

Open positions are persisted in `data/positions.json` and resume monitoring after a restart. Every buy, sell, close and reconciliation is appended to `data/trades.jsonl`, and every launch the bot sees is recorded for later analysis (see [Learning from data](#learning-from-data)).

## Survival: the bot keeps itself alive

The bot is built to protect its own bankroll. It sizes trades to what it can afford, and it stops itself before it bleeds a wallet dry.

- **Sizing follows the bankroll.** With `SIZING=fixed` every trade is `BUY_SOL`. With `SIZING=fraction` every trade is `BUY_FRACTION_PCT` of the free balance, capped at `BUY_SOL`. In both modes a trade shrinks to what is affordable when funds run low.
- **An exit reserve is never spent.** `MIN_SOL_RESERVE` is kept back so open positions can always pay their sell fees.
- **Trades that fees would eat are refused.** A trade must be large enough that tips and priority fees for the round trip stay under `MAX_FEE_DRAG_PCT` of it. With the defaults the minimum viable trade is ~0.028 SOL.
- **Defensive mode.** Once equity (balance plus open positions) falls `DEFENSIVE_DRAWDOWN_PCT` below its peak, trade size is halved until it recovers.
- **Self-shutdown.** When the wallet can't fund a viable trade, the bot goes *critical* while open positions may still bring money back. Once it is flat and still short, it declares itself **dead**, records why in `data/survival-{paper,live}.json`, and exits with **code 3**. A wallet at 0 counts too.
- **A dead bot stays dead.** On restart it refuses to run and prints how much SOL it needs. Top up the wallet (or set `PAPER_RESET=true` for paper mode) and it revives by itself. Under systemd use `RestartPreventExitStatus=3` so it isn't restarted in a loop.

Paper mode runs the same rules against a simulated wallet (`PAPER_START_SOL`), so you can watch the bot live and die before it touches real funds. The dashboard's **Vitals** tile shows state, equity, next trade size and runway (how many minimum-size trades are left).

> Survival rules keep the bot from spending money it doesn't have. They don't make it profitable. Only the strategy can do that, and most snipers lose.

## Learning from data

The bot's own trades are a small sample. The launches it *didn't* buy are the bigger lesson. `RECORD_LAUNCHES=true` (the default) writes every launch to `data/launches/<day>.jsonl`, bought or not. Each record holds:
- the features the bot decided on (dev buy, supply share, curve state, creator history, name, fees);
- the verdict and reason;
- every trade on the coin for `RECORD_HORIZON_MIN` minutes;
- the bot's own result if it traded the coin.

Recording happens after decisions, so it costs no latency. Let the bot collect a few days of data (paper mode is fine), then run:

```bash
npm run analyze             # report: what works, what doesn't, suggested filter values
npm run backtest            # grid search over exit settings (TP tiers, SL, trailing, hold, stale)
```

Both tools replay the recorded launches through the bot's **own** filter, momentum and exit functions, with fills after `PAPER_LATENCY_MS`. `analyze` reports:
- what the current settings would have made;
- whether each filter's rejects really were losers (*helps* or *costs you*);
- which features separate winners from losers;
- threshold changes that would have done better;
- how closely the replay matches the bot's actual trades, as a calibration check.

`backtest` ranks hundreds of exit configurations in seconds.

Every suggestion is validated against overfitting. Settings are chosen on the older 70% of the data and only recommended if they also beat the current settings on the newest 30%, which they were never tuned on. Reports are saved to `data/reports/`. Nothing is applied automatically: review a suggestion, try it in paper mode, and analyze again.

## Strategy

### Entry

| Mode | Behaviour |
| --- | --- |
| `ENTRY_MODE=instant` | Buy the moment a launch passes the filters (block-0 sniping). Fastest; most exposed to bundled launches and instant rugs. |
| `ENTRY_MODE=momentum` | Watch a passing launch and buy only once it has `MOMENTUM_MIN_BUYERS` distinct buyers, `MOMENTUM_MIN_NET_BUY_SOL` net inflow excluding the dev, a sell/buy ratio under `MOMENTUM_MAX_SELL_RATIO`, and the dev has not sold, all within `MOMENTUM_MAX_AGE_MS`. |

### Filters

All filters run on data already in the create transaction, so they cost microseconds. They reject:

- non-SOL-paired coins, mayhem coins (`ALLOW_MAYHEM`), and holder-reward coins if disabled;
- launches missing a metadata URI;
- names or symbols matching `NAME_BLOCKLIST` (or not matching `NAME_ALLOWLIST`);
- dev buys outside `DEV_BUY_MIN_SOL`..`DEV_BUY_MAX_SOL`, or a dev holding over `DEV_MAX_SUPPLY_PCT` of supply;
- curves already past `MAX_CURVE_PROGRESS_PCT`, or above `MAX_ENTRY_MCAP_SOL`;
- serial launchers: dev wallets with more than `CREATOR_MAX_LAUNCHES` launches in the window. This history is learned from the live stream and persisted across restarts. `CREATOR_BLOCKLIST` / `CREATOR_ALLOWLIST` override it.

`REQUIRE_SOCIALS=true` additionally fetches the off-chain metadata (with a hard timeout) and requires a Twitter, Telegram or website link. This is the only filter that adds network latency.

### Exits

Checked on every trade of the coin and once per second. The order is: protective exits first, then profit-taking, then time.

1. **Dev sold** (`EXIT_ON_DEV_SELL`): exit everything.
2. **Stop loss** at `-STOP_LOSS_PCT`.
3. **Trailing stop**: once up `TRAILING_ARM_PCT`, exit if value falls `TRAILING_STOP_PCT` from its peak.
4. **Take-profit tiers**: `TAKE_PROFIT=60:50,150:100` sells 50% of the remaining position at +60%, and the rest at +150%.
5. **Max hold** (`MAX_HOLD_SECONDS`) and **stale** (`STALE_SECONDS` without any trades).
6. **Graduation**: when the curve completes, the position is sold on PumpSwap through the official SDK.

Failed sells retry immediately with slippage widening from `SELL_SLIPPAGE_BPS` to `SELL_MAX_SLIPPAGE_BPS`. After that, the exit policy retries with backoff. Full exits also close the token account to reclaim its rent.

### Risk limits

`MAX_OPEN_POSITIONS`, `MAX_BUYS_PER_MINUTE`, and `DAILY_LOSS_LIMIT_SOL`, which pauses buying for the rest of the UTC day. Balance, trade size and the exit reserve are handled by [survival](#survival-the-bot-keeps-itself-alive). None of these can be overridden by a strategy signal.

## Dashboard and API

The dashboard at `http://localhost:8787` streams launches with the filter verdict and reason, open positions with live P&L, closed trades, latency and win rate. It also has buttons to pause buying, sell 25/50/100% of a position, sell everything, or manually buy any coin still on its bonding curve.

| Endpoint | |
| --- | --- |
| `GET /api/status` · `/api/positions` · `/api/launches` · `/api/config` | Read-only state (secrets redacted). |
| `POST /api/pause` · `/api/resume` | Stop/start new entries. |
| `POST /api/sell` `{ "mint": "...", "pct": 50 }` | Sell part of a position. |
| `POST /api/sell-all` | Exit everything. |
| `POST /api/buy` `{ "mint": "...", "sol": 0.1 }` | Manual buy of a bonding-curve coin. |
| `WS /ws` | Snapshot, then live events. |

The API binds to `127.0.0.1`. It rejects non-local Host headers (DNS rebinding) and cross-origin requests, and mutating calls must send JSON (so a CORS preflight is forced, which the server never approves). This means a malicious web page can't trade your wallet through your browser. Set `API_TOKEN` before binding it anywhere else, then open the dashboard with `?token=...`.

## Tuning for speed

- **Colocate.** Run the bot in the same region as your RPC and landing endpoints (Frankfurt, Amsterdam, New York or Salt Lake City are common). Point `HELIUS_SENDER_URL` at the regional sender (e.g. `http://fra-sender.helius-rpc.com/fast`).
- **Prefer gRPC** (`GRPC_URL`) over websockets if your provider offers it. Try `GRPC_DESHRED=true` if they support deshred.
- **Measure compute.** Run paper mode with `SIMULATE_DRY_RUN=true` and a funded wallet, then read `unitsConsumed` from `data/trades.jsonl`. Set `BUY_COMPUTE_UNITS` just above it: a lower limit at the same total fee means a higher per-CU price.
- **Watch "Landed slots after launch"** on the dashboard. It's the metric that matters, and it moves with tip, priority fee and region.

## Project layout

```
src/
  pump/        protocol: constants, PDAs, account/event decoding, curve + fee math, instruction builders
  feed/        log-stream (WS) and Yellowstone gRPC/deshred feeds; live per-coin market book
  strategy/    launch filters, creator reputation, momentum entry, exit policy, risk limits, survival
  learning/    launch recorder, dataset loading, replay engine, report helpers
  trading/     executor (build/sign/land, paper fills, simulation), positions + P&L, PumpSwap sells
  solana/      keep-alive RPC, resilient websocket, blockhash cache, priority fees, landing, confirmation
  api/         local HTTP/WS server and the single-file dashboard
  engine.ts    wires it all together; index.ts is the entrypoint
test/          protocol checks against the official SDK/IDL, strategy units, end-to-end tests on a mock chain
scripts/     demo.ts (offline demo), analyze.ts, backtest.ts
```

## Tests

```bash
npm test          # vitest
npm run typecheck
```

- **Protocol**: instruction bytes, event/account decoding and curve math are checked against `@pump-fun/pump-sdk` and the published IDL (`test/fixtures`).
- **Strategy**: config parsing, filters, exit policy, momentum, risk limits, and survival (sizing, fee-drag minimum, defensive mode, critical vs dead, persistence and revival).
- **Replay**: the offline replay matches the live exact curve math to within 2 lamports, and follows TP tiers, dev-dump exits, slippage skips and momentum timing.
- **End to end**: the real engine runs against a mock chain that verifies ed25519 signatures, decodes the submitted instructions, executes them against curve math and streams back the program's events. Covered: paper take-profit, filter rejections, momentum entry, live buy through Jito (tip, multi-path dedupe), dev-dump exit with account close, exact wallet reconciliation, failed-buy accounting, the API's security checks, a paper bot running out of money and shutting itself down (then refusing to restart), and launch recording of both rejected and traded coins.

**Not covered:** these tests can't prove landing performance or strategy profitability on mainnet. Validate with paper trading and small sizes first.

## Known limitations

- Only SOL-paired pump.fun bonding-curve coins are sniped. USDC-paired coins and other launchpads are ignored.
- Jito tip accounts are fetched from the block engine at startup; the bot refuses to start with Jito landing if that fails, rather than guess an address (override with `JITO_TIP_ACCOUNTS`).
- Paper mode can't fill graduated (PumpSwap) sells; they are booked at the last curve value.
- pump.fun changes its program regularly. When it does, update `test/fixtures/*.idl.json` from [pump-public-docs](https://github.com/pump-fun/pump-public-docs) and the `@pump-fun/pump-sdk` dev dependency, and run the tests.

## License

ISC
