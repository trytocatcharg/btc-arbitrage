# Agent Guide — btc-arbitrage

This document is a single source of truth for AI coding agents working in this repository. It is derived from the actual project files, not generic assumptions.

## Project overview

`btc-arbitrage` is a safe-by-default TypeScript monorepo that monitors BTC perpetual/futures prices across a configured pair of exchanges and visualizes arbitrage operations in a read-only web dashboard.

Current capabilities:

- Monitors BTC prices on `EXCHANGE_A` and `EXCHANGE_B`.
- Supports `risex`, `extended`, and `arcus` as exchange ids.
- Calculates absolute spread and emits a signal when `absoluteDiffUsd >= MIN_PRICE_DIFF_USD`.
- Sends Telegram alerts with a global cooldown (default one alert per hour).
- Registers `/config` and `/trade` as Telegram commands scoped to the configured chat.
- Shows a read-only web dashboard with exchange balances and mock/dry-run open operations.
- Persists price snapshots, spread snapshots, signals, trades, legs, status history, and Telegram command logs in MariaDB.

Guardrails (non-goals):

- Live order placement is globally blocked unless `BOT_EXECUTION_MODE=live` **and** `ENABLE_ORDER_PLACEMENT=true`.
- No TP/SL without Telegram confirmation.
- No real order submission from the web app or backend.
- No mutating web/API endpoints.
- No axios; use native `fetch`.

## Technology stack

| Layer | Technology |
|-------|------------|
| Language | TypeScript 5.7.2 |
| Runtime | Node.js >= 20.20.1 |
| Package manager | Yarn 4.18.0 with `nodeLinker: node-modules` |
| Monorepo | Yarn workspaces |
| Backend framework | Express 5.1.0 |
| Frontend | React 19, Vite 6, Tailwind CSS v4 |
| Database | MariaDB + Drizzle ORM 0.38.4 / Drizzle Kit 0.30.6 |
| Testing | Node.js built-in test runner (`node:test`) + `tsx` |
| Crypto/signing | `@noble/curves`, `@noble/hashes`, `@x10xchange/stark-crypto-wrapper-wasm`, `starknet` |

Important package-manager note: the root `package.json` intentionally does **not** include a `packageManager` field. Do not add one automatically.

## Monorepo layout

```txt
apps/
  bot/                  # Monitoring runtime, signal engine, Telegram bot, trade execution owner
  web/                  # Read-only React dashboard
  backend/              # Read-only Express API for balances
packages/
  config/               # Environment parsing and bot/backend config loading
  db/                   # Drizzle schema, connection pool, migrations
  domain/               # Shared types, enums, and pure domain functions (spread calculation, decimal helpers)
  exchange-core/        # Exchange adapter contracts and normalization helpers
  shared/               # Tiny shared runtime utilities (sleep, invariant)
docs/
  architecture.md       # Project-level architecture rules
  web-dashboard.md      # Web dashboard details
  open-trade-routing.md # Entry leg routing rule
  exchanges/            # Per-exchange integration specs
specs/                  # Per-app specifications
```

Workspace packages are referenced with `workspace:*` and TypeScript path mapping is centralized in `tsconfig.base.json`.

## Build and test commands

All commands should be run from the repository root.

### Install

If your global Yarn is 1.x, use Corepack with auto-pin disabled to avoid metadata changes:

```bash
COREPACK_ENABLE_AUTO_PIN=0 corepack yarn@4.5.3 install
```

If your shell already resolves to Yarn 4:

```bash
yarn install
```

### Development

```bash
yarn dev:bot      # bot only
yarn dev:web      # web + backend (frontend dev server + backend API)
yarn dev:backend  # backend only
yarn dev          # backend + web (concurrent)
```

### Production start

```bash
yarn build
yarn start        # builds, then runs backend + bot + web concurrently
```

### Build

```bash
yarn build        # all packages and apps
yarn build:bot    # packages required by the bot + bot
yarn build:backend
```

### Type checking / lint

Lint is implemented as TypeScript checking:

```bash
yarn typecheck
yarn lint         # alias for typecheck
```

### Tests

```bash
yarn test         # builds then runs all workspace tests
```

Each workspace also supports its own `test` script. Most use:

```bash
node --import tsx --test test/**/*.test.ts
```

### Database

```bash
yarn db:generate  # drizzle-kit generate
yarn db:migrate   # drizzle-kit migrate
yarn db:studio    # drizzle-kit studio
```

For a fresh MariaDB database you can also apply the manual SQL script:

```bash
mariadb \
  --host "$DATABASE_HOST_NAME" \
  --port "$DB_PORT" \
  --user "$DATABASE_USER_NAME" \
  --password \
  "$DATABASE_DB_NAME" < packages/db/scripts/001_create_schema.sql
```

## Configuration

Copy `.env.example` to `.env` and fill in real values:

```bash
cp .env.example .env
```

Never commit `.env` or real credentials. Tokens, private keys, API keys, and DB passwords must never be logged.

Key environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `EXCHANGE_A` | `risex` | First exchange to monitor |
| `EXCHANGE_B` | `extended` | Second exchange to monitor |
| `PRICE_SOURCE` | `mark` | `mark` / `index` / `last` |
| `MIN_PRICE_DIFF_USD` | `40` | Spread threshold in USD |
| `LEVERAGE` | `3` | Leverage used in signals and trades |
| `BOT_EXECUTION_MODE` | `dry-run` | `dry-run` or `live` |
| `ENABLE_ORDER_PLACEMENT` | `false` | Global gate for live order placement |
| `TELEGRAM_ENABLED` | `false` | Enable Telegram alerts/commands |
| `TELEGRAM_BOT_TOKEN` | | Bot token |
| `TELEGRAM_CHAT_ID` | | Allowed chat id |
| `DATABASE_HOST_NAME` | `127.0.0.1` | MariaDB host |
| `DATABASE_USER_NAME` | `user` | MariaDB user |
| `DB_PORT` | `3306` | MariaDB port |
| `DATABASE_USER_PASSWORD` | `password` | MariaDB password |
| `DATABASE_DB_NAME` | `btc_arbitrage` | MariaDB database |
| `BACKEND_HOST` / `BACKEND_PORT` | `0.0.0.0:3002` | Backend bind address |
| `VITE_BACKEND_API_BASE_URL` | `http://127.0.0.1:3002` | Web → backend URL |

Safe defaults:

```txt
EXCHANGE_A=risex
EXCHANGE_B=extended
PRICE_SOURCE=mark
MIN_PRICE_DIFF_USD=40
LEVERAGE=3
BOT_EXECUTION_MODE=dry-run
ENABLE_ORDER_PLACEMENT=false
RISEX_TRADING_ENABLED=false
EXTENDED_TRADING_ENABLED=false
ARCUS_TRADING_ENABLED=false
```

`BOT_EXECUTION_MODE=live` requires `ENABLE_ORDER_PLACEMENT=true`, and vice versa.

## Code organization and conventions

### Domain ownership

- Pure domain types, enums, and functions live in `packages/domain`.
- Use the `ExecutionMode` enum everywhere; do not duplicate `'dry-run'` / `'live'` strings in app code.
- Decimal math uses `parseDecimal` / `formatDecimal` from `@btc-arbitrage/domain`.

### Database access

- All application DB access must use `getDb()` from `@btc-arbitrage/db`.
- Import tables from `@btc-arbitrage/db`.
- Do not create ad-hoc pools or connections in feature code.

### Exchange adapters

- Exchange adapter contract is in `packages/exchange-core/src/index.ts`.
- Implementations live under `apps/bot/src/exchanges/{risex,extended,arcus}/`.
- Registry is `apps/bot/src/exchanges/registry.ts`.
- Each adapter must fail closed when the configured `PRICE_SOURCE` is missing from the exchange payload.
- Per-exchange specs are authoritative: `docs/exchanges/*.md`.

### Web dashboard

- Tailwind CSS v4 is configured in CSS only (`apps/web/src/styles/tailwind.css`).
- There is no `tailwind.config.ts` or `postcss.config.js`.
- Components follow one component per file under `apps/web/src/features/dashboard/components/`.
- Shared helpers live next to the feature: `dashboard-formatters.ts`, `dashboard-styles.ts`, `dashboard-types.ts`, `operations.ts`, `mock-operations.ts`.
- React components are typed functional components with `FC<Props>`.
- Semantic PnL tokens: `profit`, `profit-border`, `loss`, `loss-border`.
- The dashboard is read-only; it must not place orders or mutate bot state.

### Backend

- Entry point: `apps/backend/src/main.ts`.
- Server factory: `apps/backend/src/server.ts`.
- Routes are read-only; there are no write endpoints.
- Balance reads are normalized to `ExchangeBalance` / `ExchangeBalancesResponse` from `@btc-arbitrage/domain`.

### Bot

- Entry point: `apps/bot/src/main.ts`.
- Main loop: `apps/bot/src/runtime/polling-loop.ts`.
- Signal engine: `apps/bot/src/signals/signal-engine.ts`.
- Telegram notifications: `apps/bot/src/notifications/telegram-notifier.ts`.
- Telegram command/callback poller: `apps/bot/src/notifications/telegram-command-poller.ts`.
- Open trade execution: `apps/bot/src/trading/open-trade.ts`.
- Trade preview persistence: `apps/bot/src/trading/db-preview-store.ts`.
- Trade monitoring: `apps/bot/src/trading/trade-monitor.ts`.

### Open Trade routing rule

Entry legs must be routed with this priority:

1. Choose the cheaper maker venue first.
2. If maker fees tie, choose the cheaper taker venue.

Maker = limit order, taker = market order. See `docs/open-trade-routing.md`.

## Testing strategy

- Tests use Node.js built-in `node:test` and `node:assert/strict`.
- Tests are run via `tsx` so source TypeScript can be imported directly.
- Tests live in `test/` directories inside each workspace.
- Example: `apps/bot/test/signal-engine.test.ts`, `packages/domain/test/spread.test.ts`.

⚠️ **Unit-test work is paused by explicit user instruction as of 2026-08-16.** Do not add or expand unit tests unless the user explicitly re-enables them.

## Security considerations

- **Live trading is blocked by default.** Do not enable it without explicit user approval.
- Required gates for live trading:
  - `BOT_EXECUTION_MODE=live`
  - `ENABLE_ORDER_PLACEMENT=true`
  - Exchange-specific flag (`RISEX_TRADING_ENABLED`, `EXTENDED_TRADING_ENABLED`, or `ARCUS_TRADING_ENABLED`) set to `true`
  - Valid credentials for the enabled exchange(s)
- Telegram commands and callbacks are restricted to `TELEGRAM_CHAT_ID`.
- Secrets are redacted by `redactSecrets()` in `@btc-arbitrage/config` before logging.
- Private keys, API keys, tokens, and DB passwords must never be logged or committed.
- The backend is public/read-only and must not expose order placement.
- The web app is read-only and must not contain exchange signing logic or Telegram confirmation logic.
- Trade execution authority belongs to the bot process only.

## Deployment notes

- The `start` script builds everything and runs backend, bot, and web concurrently.
- In Docker/Portainer/Kubernetes, env vars are typically injected instead of using a repo `.env` file; the log line `Environment file status { loaded: false }` is expected in that case.
- For bot-only containers, run `build:bot` before `start` because `yarn start:bot` executes `node dist/main.js`.

## Useful references

- `README.md` — first-run instructions and high-level overview.
- `docs/architecture.md` — project-level architecture rules.
- `docs/web-dashboard.md` — web dashboard details.
- `docs/open-trade-routing.md` — entry leg routing rule.
- `docs/exchanges/*.md` — per-exchange specs and integration contracts.
- `specs/*.md` — per-app specifications.
- `packages/db/README.md` — DB package usage.
