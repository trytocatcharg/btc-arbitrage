# Agent Guide — btc-arbitrage

This document is a single source of truth for AI coding agents working in this repository. It is derived from the actual project files, not generic assumptions. Last verified against the codebase: 2026-09-07.

## Project overview

`btc-arbitrage` is a safe-by-default TypeScript monorepo that monitors BTC perpetual prices across a configured pair of exchanges, emits spread signals, and can execute hedged open trades (maker limit entry + immediate taker hedge + TP/SL protection) via Telegram confirmation. A read-only web dashboard visualizes balances and dry-run operations.

Current capabilities:

- Monitors BTC prices on `EXCHANGE_A` and `EXCHANGE_B` (any pair of `risex`, `extended`, `arcus`).
- Calculates absolute spread and emits a signal when `absoluteDiffUsd >= MIN_PRICE_DIFF_USD`.
- Signals are suppressed while any trade is in an active status.
- Sends Telegram alerts with a global cooldown (default one alert per hour, `TELEGRAM_ALERT_COOLDOWN_MS`).
- Telegram commands `/config` and `/trade`, plus an `Open Trade` inline button on each signal with `Confirm`/`Cancel` preview flow.
- Open trade execution (bot-only, Telegram-confirmed): passive maker-limit entry with retry, immediate market hedge per fill increment, then automatic TP/SL reduce-only orders on both legs.
- Trade monitoring detects leg closure via position polling and notifies `closed` or `unhedged` states.
- Persists price snapshots, spread snapshots, signals, trades, trade legs, trade previews, status history, Telegram command logs, operations, and events in MariaDB.
- Append-only JSONL audit logs for trade execution and Telegram callbacks (`logs/open-trade.jsonl`, `logs/telegram-commands.jsonl`).

Guardrails (non-goals):

- No order placement without the operator explicitly confirming a Telegram preview. No auto-trading on signals.
- No real order submission from the web app or backend.
- No mutating web/API endpoints.
- Arcus is market-data only: `capabilities.orderPlacement: false`, no execution adapter.
- No axios; use native `fetch`.

## Technology stack

| Layer | Technology |
| ------- | ------------ |
| Language | TypeScript 5.7.2 |
| Runtime | Node.js >= 20.20.1 |
| Package manager | Yarn 4.18.0 (`nodeLinker: node-modules`), pinned via root `packageManager` field |
| Monorepo | Yarn workspaces |
| Backend framework | Express 5.1.0 |
| Frontend | React 19, Vite 6, Tailwind CSS v4 (CSS-first config) |
| Database | MariaDB + Drizzle ORM 0.38.4 / Drizzle Kit 0.30.6 |
| Testing | Node.js built-in test runner (`node:test`) + `tsx` |
| Crypto/signing | `@noble/curves`, `@noble/hashes`, `@x10xchange/stark-crypto-wrapper-wasm`, `starknet` |

## Monorepo layout

```txt
apps/
  bot/                  # Monitoring runtime, signal engine, Telegram bot, trade execution owner
  web/                  # Read-only React dashboard
  backend/              # Read-only Express API for balances
packages/
  config/               # Environment parsing (loadBotConfig), dotenv loading, redactSecrets()
  db/                   # Drizzle schema, connection pool (getDb), migrations
  domain/               # Shared types, enums, pure domain functions (spread, decimals)
  exchange-core/        # ExchangeAdapter / ExecutionAdapter contracts, normalizeSymbol()
  shared/               # sleep(), invariant()
docs/
  architecture.md       # Project-level architecture rules
  web-dashboard.md      # Web dashboard details
  open-trade-routing.md # Entry leg routing rule
  exchanges/            # Per-exchange integration specs (README, arcus, extended,
                        # extended-execution, risex, risex-integration)
specs/                  # Per-app specifications (bot, backend, web, exchange-execution)
```

Workspace packages are referenced with `workspace:*` and TypeScript path mapping is centralized in `tsconfig.base.json` (`module: NodeNext`, `strict`).

## Build, run, and test commands

All commands run from the repository root.

### Install

```bash
COREPACK_ENABLE_AUTO_PIN=0 corepack yarn@4.5.3 install   # if global Yarn is 1.x
yarn install                                              # if Yarn 4 already active
```

### Development

```bash
yarn dev:bot      # bot only (tsx, watch-like)
yarn dev:web      # web only: vite on http://localhost:5173 (strictPort)
yarn dev:backend  # backend only (builds first, then node dist/main.js — no watch mode)
yarn dev          # backend + web concurrently
```

### Build and production start

```bash
yarn build        # all packages and apps
yarn build:bot    # packages required by the bot + bot
yarn build:backend
yarn start        # builds, then runs backend + bot + web concurrently
```

`yarn start:bot` executes `node dist/main.js` — always `yarn build:bot` first for bot-only containers.

### Type checking / lint

Lint is TypeScript checking: `yarn typecheck` (alias `yarn lint`).

### Tests

```bash
yarn test         # builds, then runs all workspace tests
```

Per workspace: `node --import tsx --test test/**/*.test.ts`. Note: `apps/web` has no test framework (its `test` script is typecheck-only).

### Database

```bash
yarn db:generate  # drizzle-kit generate
yarn db:migrate   # drizzle-kit migrate
yarn db:studio    # drizzle-kit studio
```

Fresh database alternative:

```bash
mariadb --host "$DATABASE_HOST_NAME" --port "$DB_PORT" --user "$DATABASE_USER_NAME" \
  --password "$DATABASE_DB_NAME" < packages/db/scripts/001_create_schema.sql
```

## Configuration

Copy `.env.example` to `.env` and fill in real values. Never commit `.env` or real credentials. Tokens, private keys, API keys, and DB passwords must never be logged — `redactSecrets()` from `@btc-arbitrage/config` deep-redacts keys matching `token|key|secret|private|signature|authorization|password|databaseUrl`.

### Key environment variables

| Variable | Default | Purpose |
| ---------- | --------- | --------- |
| `EXCHANGE_A` / `EXCHANGE_B` | `risex` / `extended` | Monitored pair (must differ) |
| `EXCHANGE_LONG` / `EXCHANGE_SHORT` | — | Optional directional overrides |
| `BTC_SYMBOL` | `BTCUSDT` | Traded symbol |
| `MARKET_TYPE` | `perpetual` | `perpetual` / `futures` |
| `PRICE_SOURCE` | `mark` | `mark` / `index` / `last` |
| `PRICE_POLL_INTERVAL_MS` | `1000` | Main loop sleep between ticks |
| `MIN_PRICE_DIFF_USD` | `40` | Spread threshold |
| `LEVERAGE` | `3` | Leverage in signals and trades |
| `BOT_RUN_ONCE` | `false` | Run a single tick and exit |
| `BOT_EXECUTION_MODE` | `dry-run` | `dry-run` / `live` (cross-validated with `ENABLE_ORDER_PLACEMENT`) |
| `ENABLE_ORDER_PLACEMENT` | `false` | Cross-validated with mode; see "Execution gates" below |
| `RISEX_TRADING_ENABLED` / `EXTENDED_TRADING_ENABLED` / `ARCUS_TRADING_ENABLED` | `false` | Per-exchange live trading gates |
| `OPEN_TRADE_NOTIONAL_USD` | `100` | Preview notional |
| `OPEN_TRADE_PREVIEW_TTL_MS` | `120000` | Preview expiry |
| `OPEN_TRADE_QUOTE_MAX_AGE_MS` | `5000` | BBO freshness assertion |
| `OPEN_TRADE_LIMIT_TIMEOUT_MS` | `30000` | Passive limit fill wait |
| `OPEN_TRADE_RESIDUAL_DELTA_BTC` | `0.00001` | Plumbed but not enforced (see landmines) |
| `OPEN_TRADE_TAKE_PROFIT_PERCENT` / `OPEN_TRADE_STOP_LOSS_PERCENT` | `3` / `3` | TP/SL applied on confirm |
| `RISEX_MAKER_FEE_BPS` / `RISEX_TAKER_FEE_BPS` | `1` / `3` | Routing fee inputs |
| `EXTENDED_MAKER_FEE_BPS` / `EXTENDED_TAKER_FEE_BPS` | `0` / `2.5` | Routing fee inputs |
| `TELEGRAM_ENABLED` / `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | `false` / — / — | Bot enablement; token+chat required when enabled |
| `TELEGRAM_ALERT_COOLDOWN_MS` | `3600000` | Signal alert cooldown (1 h) |
| `DATABASE_HOST_NAME` / `DATABASE_USER_NAME` / `DB_PORT` / `DATABASE_USER_PASSWORD` / `DATABASE_DB_NAME` | `127.0.0.1` / `user` / `3306` / `password` / `btc_arbitrage` | MariaDB connection |
| `BACKEND_HOST` / `BACKEND_PORT` | `127.0.0.1` / `3002` | Backend bind address |
| `BACKEND_CORS_ORIGINS` | `http://127.0.0.1:5173,http://localhost:5173` | CORS allowlist; `*` supported |
| `VITE_BACKEND_API_BASE_URL` | same-host port 3002 fallback | Web → backend URL |
| `LOG_LEVEL` | `info` | Bot log level |
| `DATA_RETENTION_ENABLED` | `true` | Daily prune of snapshots/signals |
| `DATA_RETENTION_DAYS` | `30` | Days of history kept (≥1) |
| `DATA_RETENTION_BATCH_SIZE` | `5000` | Rows per DELETE batch |

## Execution gates (read carefully — common misconception)

- `loadBotConfig()` cross-validates `BOT_EXECUTION_MODE=live` ⇔ `ENABLE_ORDER_PLACEMENT=true` (throws otherwise), and these are displayed in the `/config` summary.
- **However, neither flag is checked at runtime in the bot.** The actual gate that prevents live orders is per-adapter: `risex-execution-adapter.ts` `requireTradingCredentials()` and `extended-execution-adapter.ts` `requireTradingEnabled()`, driven by `RISEX_TRADING_ENABLED` / `EXTENDED_TRADING_ENABLED` plus valid credentials.
- Arcus has no execution adapter at all — trading there is impossible regardless of flags.
- Never re-introduce a claim that mode/placement flags gate execution; fix code toward the documented intent instead, and ask the user before changing gate semantics.

## Code organization and conventions

### Domain ownership (`packages/domain/src/index.ts`)

- Types: `ExchangeId`, `MarketType`, `PriceSource`, `OrderSide`, `ExchangeBalanceStatus`, `SignalStatus`, `OperationStatus`, `EventLevel`; interfaces `PriceSnapshot`, `SpreadSnapshot`, `TradingSignal`, `Operation`, `ExchangeBalance`, `ExchangeBalancesResponse`, `EventRecord`.
- Enum `ExecutionMode { DryRun = 'dry-run', Live = 'live' }` — use it everywhere; never duplicate the string literals.
- `calculateSpread()` computes `absoluteDiffUsd`, `diffBps`, `direction`, `thresholdMatched`.
- Decimal math: `parseDecimal(value, fieldName?)` (strict, throws) and `formatDecimal(value, fractionDigits = 8)`.

### Database access (`packages/db`)

- All DB access uses `getDb()` from `@btc-arbitrage/db`; import tables from `@btc-arbitrage/db`. No ad-hoc pools in feature code.
- Tables: `price_snapshots`, `spread_snapshots`, `signals`, `trades`, `trade_previews`, `trade_legs`, `trade_status_history`, `telegram_command_logs`, `operations`, `events`. Money columns are `decimal(24,8)`.
- Status sets: `tradeStatuses` (10 values from `awaiting_confirmation` to `failed`); `activeTradeStatuses` = `openTradeStatuses` = `['executing_limit','hedging','protecting','open','closing','unhedged']`; leg statuses `['planned','submitted','open','unhedged','closed','cancelled','failed']`.
- Drizzle migrations live in `packages/db/migrations/` (0000 initial schema, 0001 open-trade execution). See landmines for migration drift.

### Exchange adapters

- Contracts in `packages/exchange-core/src/index.ts`: `ExchangeAdapter` (market data + optional `execution: ExecutionAdapter`) and `ExecutionAdapter` (BBO, metadata, margin, preflight, submit/get/cancel order, position). Helper: `normalizeSymbol()`.
- Implementations under `apps/bot/src/exchanges/{risex,extended,arcus}/`; registry at `apps/bot/src/exchanges/registry.ts` (`createExchangeRegistry`, `get(id)` throws on unknown).
- The RISEx SDK copy adapted from the community TS SDK lives at `apps/bot/src/exchanges/risex/sdk/` (EIP-712/permit signing, nonce, TP/SL encoders). This is project code — maintain it here.
- Each adapter must fail closed when the configured `PRICE_SOURCE` is missing from the payload.
- Per-exchange specs are authoritative: `docs/exchanges/*.md`. Note the distinction: `docs/exchanges/risex-integration.md` mirrors the official RISEx REST doc (including `/v1/orders/tpsl`), while `specs/exchange-execution.md` records that RISEx TP/SL endpoints must not ship until enum encodings are verified.

### Bot (`apps/bot/src/`)

- Entry: `main.ts`; loop: `runtime/polling-loop.ts`. Each tick: poll Telegram commands → `monitorTrades()` → fetch both price snapshots → `calculateSpread()` → `SignalEngine.evaluate()` → on signal, suppress if active trades exist, else insert `signals` row and `notifier.notifySignal()`.
- Signal engine: `signals/signal-engine.ts` — threshold only; cooldowns live in the notifier, suppression in `trading/trade-guards.ts`.
- Telegram: `notifications/telegram-notifier.ts` (cooldown + chat restriction + `Open Trade` button), `notifications/telegram-command-poller.ts` (`/config`, `/trade`, `open:`/`confirm:`/`cancel:` callbacks), `notifications/trade-summary.ts`.
- Trading: `trading/open-trade.ts` (`OpenTradeService` — preview/confirm state machine), `trading/db-preview-store.ts` (atomic preview consumption + tx trade/leg creation + rollback claim), `trading/trade-monitor.ts` (position-based leg closure detection), `trading/trade-guards.ts` (pure guard functions).
- Open-trade flow on confirm: create `trades` row (mode `live`) + 2 `trade_legs` (`planned`) → preflight + margin checks → passive limit entry (price = bid/ask, post-only; up to 3 retries only on `PostOnlyOrderMatched`) → poll fill every 250 ms up to `OPEN_TRADE_LIMIT_TIMEOUT_MS` → hedge each fill immediately with a market order on the other venue → cancel remainder → place TP (`take-profit-market`) and SL (`stop-market`) reduce-only on both legs → status `open`. Failure mid-way with covered quantity triggers `claimRollback`: cancel orders + emergency reduce-only market closes + urgent notify + status `failed`.
- Logging: `logging/json-file-logger.ts` (JSONL append with mkdir, errors swallowed).

### Backend (`apps/backend/src/`)

- Entry: `main.ts`; server factory: `server.ts` (`createBackendApp`).
- Routes (all read-only): `GET /health`, `GET /api/exchanges/balances`, `GET /api/exchanges/risex/balance`, `GET /api/exchanges/extended/balance`.
- Balance service: `exchanges/balance-service.ts` via `exchanges/http-client.ts` (`JsonHttpClient`, 10 s timeout); normalized by `exchanges/balance-normalizers.ts` to `ExchangeBalance` / `ExchangeBalancesResponse` from `@btc-arbitrage/domain` (asset hardcoded `USDC`; Extended 404 → synthetic zero balance).
- `exchanges/risex-auth.ts` (`RisexJwtAuthProvider`) is fully implemented but currently unused — reserved.

### Web dashboard (`apps/web/src/`)

- Vite dev server pinned to `localhost:5173` (`--strictPort`); **no dev proxy** — cross-origin calls rely on backend CORS.
- Tailwind v4 configured in CSS only (`styles/tailwind.css` with `@theme` tokens); no `tailwind.config.ts`, no `postcss.config.js`.
- Feature dir `features/dashboard/`: one component per file under `components/`; helpers `dashboard-formatters.ts`, `dashboard-styles.ts`, `dashboard-types.ts`, `operations.ts`, `mock-operations.ts`.
- Real data: balances from `GET {VITE_BACKEND_API_BASE_URL}/api/exchanges/balances`, refreshed every 30 s.
- Operations are mock-only: `mock-operations.ts` is shown when `import.meta.env.BOT_EXECUTION_MODE === 'dry-run'` (hence `envPrefix: ['VITE_', 'BOT_']` in `vite.config.ts`); live mode shows zero operations (no API exists).
- Semantic PnL tokens: `profit`, `profit-border`, `loss`, `loss-border`.
- The dashboard is read-only; it must not place orders or mutate bot state.

### Open Trade routing rule

Entry legs are routed with this priority (`docs/open-trade-routing.md` is the permanent spec):

1. Choose the cheaper maker venue first.
2. If maker fees tie, choose the cheaper taker venue.

Maker = limit order, taker = market order. Short leg goes to the higher-bid venue; long leg to the other side.

## Testing strategy

- Tests use Node.js built-in `node:test` and `node:assert/strict`, run via `tsx` importing source TypeScript directly.
- Tests live in `test/` directories inside each workspace (e.g., `apps/bot/test/open-trade.test.ts`, `packages/domain/test/spread.test.ts`).

⚠️ **Unit-test work is paused by explicit user instruction as of 2026-08-16** (recorded in `docs/exchanges/README.md`). Do not add or expand unit tests unless the user explicitly re-enables them.

## Security considerations

- **Live trading is blocked by default.** Do not enable it without explicit user approval.
- What actually gates live orders at runtime: per-exchange `*_TRADING_ENABLED=true` plus valid credentials, consumed by the execution adapters. `BOT_EXECUTION_MODE` / `ENABLE_ORDER_PLACEMENT` are config-level cross-validation and display only.
- Telegram commands and callbacks are restricted to `TELEGRAM_CHAT_ID` (both chat and user id are compared against it — designed for single-operator private chats).
- Order placement authority belongs to the bot process only; the operator surface is Telegram preview confirmation.
- Secrets are redacted by `redactSecrets()` before logging. Private keys, API keys, tokens, and DB passwords must never be logged or committed.
- The backend is public/read-only and must not expose order placement. The web app is read-only and must not contain exchange signing logic or Telegram confirmation logic.

## Deployment notes

- The `start` script builds everything and runs backend, bot, and web concurrently; it binds the backend to `0.0.0.0` with `BACKEND_CORS_ORIGINS="*"`.
- In Docker/Portainer/Kubernetes, env vars are typically injected instead of a repo `.env`; the log line `Environment file status { loaded: false }` is expected.
- Web production preview binds `0.0.0.0:4173`; its backend URL falls back to same-host port 3002.

## Known landmines (verified stale/dead code — do not trust blindly)

- **Root `README.md` is stale** about trading: it claims live order placement/TP/SL are not implemented. They are (`specs/bot.md`, `specs/exchange-execution.md`, `docs/exchanges/extended-execution.md`). Follow specs over README.
- `CONFIRM_LIVE_TRADING` is parsed into `BotConfig.confirmLiveTrading` but never read — dead config.
- `OPEN_TRADE_RESIDUAL_DELTA_BTC` is plumbed into options but not enforced in the confirm flow.
- `apps/bot/src/exchanges/unsupported-execution.ts` is exported but never imported (arcus omits `execution` entirely).
- `apps/backend/src/exchanges/risex-auth.ts` has zero callers.
- `apps/bot/src/api/` is an empty directory.
- Bot `test:watch` script points at `dist-test/**` which nothing produces.
- `validateDbConnection` is imported in bot `main.ts` but its call is commented out.
- `packages/db/src/connection.ts` has stale fallback defaults (`root`/empty password/`wolfe_trading`) that contradict `loadDatabaseConfig` — harmless when env vars are set, but do not copy them.
- Committed build artifacts (`*.js`, `*.d.ts`, maps) sit next to sources in `packages/db/src/` and are stale (e.g., `schema.js` has an old `openTradeStatuses` list). Runtime uses `.ts` via tsx; ignore the `.js` files, and do not import from them.
- Migration drift: `migrations/meta/` has no `0001_snapshot.json`, and migration 0001 did not widen `trade_status_history` enum columns while `schema.ts` types them with the full 10-value set.
- `packages/db/README.md` documents an outdated `openTradeStatuses` list.
- Signal suppression in `polling-loop.ts` uses `continue`, which skips the tick's sleep — the loop does not rest while a trade stays active. Treat as a known quirk; ask before "fixing" behavior changes.
- `docs/architecture.md` claims the root `package.json` intentionally lacks a `packageManager` field — it now has one (`yarn@4.18.0`). The doc is wrong; the field is correct.

## Useful references

- `README.md` — first-run instructions (trading sections stale; see landmines).
- `docs/architecture.md` — project-level architecture rules.
- `docs/open-trade-routing.md` — entry leg routing rule.
- `docs/web-dashboard.md` — web dashboard details.
- `docs/exchanges/*.md` — per-exchange specs and integration contracts.
- `specs/bot.md`, `specs/exchange-execution.md` — trading workflow and execution ownership (authoritative for what is implemented).
- `specs/backend.md`, `specs/web.md` — read-only API and dashboard specs.
- `packages/db/README.md` — DB usage (status lists partially stale; trust `schema.ts`).
