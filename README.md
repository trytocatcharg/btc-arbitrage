# btc-arbitrage

Safe-by-default TypeScript monorepo for monitoring BTC perpetual/futures prices across a configured exchange pair and visualizing arbitrage operations in a read-only web dashboard.

## Current state

| Area | Status |
|---|---|
| Bot | Monitors BTC prices on two configured exchanges and sends Telegram alerts when spread threshold is met. |
| Exchanges | Read-only market data adapters for RISEx, Extended, and Arcus. |
| Trading | Blocked. No live order placement, TP, or SL is implemented yet. |
| Database | MariaDB + Drizzle schema and SQL scripts for prices, spreads, signals, events, trades, legs, status history, and Telegram command logs. |
| Web | React + Tailwind CSS v4 read-only dashboard for open operations, dry-run mocks, and net PnL visualization. |
| Telegram | Alerts plus `/config` command, both restricted to `TELEGRAM_CHAT_ID`. |

## What works now

- Monitors BTC price snapshots from `EXCHANGE_A` and `EXCHANGE_B`.
- Supports `risex`, `extended`, and `arcus` as exchange ids.
- Calculates absolute spread and emits a signal when `absoluteDiffUsd >= MIN_PRICE_DIFF_USD`.
- Sends Telegram alerts with a global cooldown; default is one alert per hour.
- Registers `/config` as a Telegram command scoped to the configured chat.
- Shows a web dashboard with open operations and net PnL.
- Uses dry-run mock operations in the web when `BOT_EXECUTION_MODE` is not `live`.

## Monorepo layout

```txt
apps/bot      Node.js + TypeScript monitoring runtime
apps/web      React + Tailwind v4 read-only operations dashboard
packages/config
packages/db
packages/domain
packages/exchange-core
packages/shared
docs
```

## Tooling

The repo uses Yarn workspaces with a Yarn Berry lockfile.

Important: the root `package.json` intentionally does **not** include `packageManager`. Do not add it automatically.

If your global `yarn --version` is `1.x`, prefer explicit Corepack commands to avoid accidental package metadata changes:

```bash
COREPACK_ENABLE_AUTO_PIN=0 corepack yarn@4.5.3 install
COREPACK_ENABLE_AUTO_PIN=0 corepack yarn@4.5.3 dev:bot
COREPACK_ENABLE_AUTO_PIN=0 corepack yarn@4.5.3 dev:web
```

If your shell already resolves to Yarn 4, these are enough:

```bash
yarn install
yarn dev:bot
yarn dev:web
```

## First run

```bash
COREPACK_ENABLE_AUTO_PIN=0 corepack yarn@4.5.3 install
cp .env.example .env
COREPACK_ENABLE_AUTO_PIN=0 corepack yarn@4.5.3 dev:bot
COREPACK_ENABLE_AUTO_PIN=0 corepack yarn@4.5.3 dev:web
```

Do not commit real credentials. Tokens, private keys, API keys, and DB passwords must never be logged.

## Bot configuration

Safe defaults:

```txt
EXCHANGE_A=risex
EXCHANGE_B=extended
PRICE_SOURCE=mark
MIN_PRICE_DIFF_USD=40
LEVERAGE=3
BOT_EXECUTION_MODE=dry-run
BOT_RUN_ONCE=false
RISEX_TRADING_ENABLED=false
EXTENDED_TRADING_ENABLED=false
ARCUS_TRADING_ENABLED=false
ENABLE_ORDER_PLACEMENT=false
```

`BOT_EXECUTION_MODE=live` and `ENABLE_ORDER_PLACEMENT=true` are blocked until live trading is intentionally implemented.

The runtime uses the global `ExecutionMode` enum from `@btc-arbitrage/domain`; do not duplicate `dry-run` / `live` strings in app code.

## Telegram

Required for alerts and commands:

```txt
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
TELEGRAM_ALERT_COOLDOWN_MS=3600000
```

Rules:

- Alerts are sent only to `TELEGRAM_CHAT_ID`.
- Inbound commands are ignored unless `chat.id` matches `TELEGRAM_CHAT_ID`.
- `/config` returns the active basic bot configuration and configured Exchange A / Exchange B.
- On startup, the bot registers `/config` through `setMyCommands` scoped to the configured chat.

## Web dashboard

The web app is read-only.

Current dashboard sections:

- Open operations.
- Two exchange legs per operation.
- Entry price, mark price, size, notional, margin, leverage, fees, funding, liquidation price.
- PnL per leg.
- Net open PnL across both legs.
- Historical operations placeholder for the next slice.

Dry-run behavior:

```bash
BOT_EXECUTION_MODE=dry-run COREPACK_ENABLE_AUTO_PIN=0 corepack yarn@4.5.3 dev:web
```

When dry-run is active, the dashboard uses mock open operations from:

```txt
apps/web/src/features/dashboard/mock-operations.ts
```

Mock `fundingUsd` and `unrealizedPnlUsd` values are randomized on module load so refreshes can show different positive/negative PnL states.

More detail: [`docs/web-dashboard.md`](./docs/web-dashboard.md).

## Tailwind CSS v4

The web uses Tailwind CSS v4 with the official Vite plugin.

Key files:

```txt
apps/web/vite.config.ts
apps/web/src/styles/tailwind.css
```

There is no `tailwind.config.ts` and no `postcss.config.js` for the web app. Tailwind v4 theme tokens live in CSS:

```css
@theme {
  --color-profit-border: oklch(52% 0.13 154);
}
```

That token generates utilities such as:

```txt
border-profit-border
bg-profit-border
text-profit-border
```

## Database

The bot and Drizzle use these MariaDB env vars:

```txt
DATABASE_HOST_NAME=127.0.0.1
DATABASE_USER_NAME=user
DB_PORT=3306
DATABASE_USER_PASSWORD=password
DATABASE_DB_NAME=btc_arbitrage
```

DB access rule:

```ts
const db = await getDb();
const rows = await db.select().from(priceSnapshots);
```

All application DB access must use `getDb()` from `@btc-arbitrage/db`. Do not create ad-hoc pools in bot/web code.

Manual SQL scripts:

```bash
mariadb \
  --host "$DATABASE_HOST_NAME" \
  --port "$DB_PORT" \
  --user "$DATABASE_USER_NAME" \
  --password \
  "$DATABASE_DB_NAME" < packages/db/scripts/001_create_schema.sql
```

More detail:

- [`packages/db/README.md`](./packages/db/README.md)
- [`packages/db/scripts/README.md`](./packages/db/scripts/README.md)
- [`docs/architecture.md`](./docs/architecture.md)

## Docker command for bot only

For a fresh clone inside a container, build the bot before starting it because `yarn start` runs `node dist/main.js`:

```sh
command: >
  sh -c "
    set -e &&
    corepack enable || true &&
    mkdir -p /app/btc-arbitrage &&
    cd /app/btc-arbitrage &&
    if [ ! -d .git ]; then
      git clone $${REPO_URL} .;
    else
      git pull --ff-only;
    fi &&
    COREPACK_ENABLE_AUTO_PIN=0 corepack yarn@4.5.3 install &&
    COREPACK_ENABLE_AUTO_PIN=0 corepack yarn@4.5.3 build:bot &&
    COREPACK_ENABLE_AUTO_PIN=0 corepack yarn@4.5.3 start
  "
```

In Docker, `Environment file status { loaded: false }` is OK when env vars are injected by Compose/Portainer/Kubernetes instead of a repo `.env` file.

## Exchange contracts

Local specs under [`docs/exchanges/`](./docs/exchanges/) are the repo-level adapter contract. Update those docs before changing adapter behavior or enabling live trading.

Current adapter behavior is fail-safe: if the configured `PRICE_SOURCE` is not present in the exchange market payload, the bot throws an explicit error instead of silently falling back.

## Architecture rules

Project-level decisions live in [`docs/architecture.md`](./docs/architecture.md).

Most important rules:

- DB access goes through `getDb()`.
- Shared runtime values such as `ExecutionMode` live in `packages/domain`.
- Web dashboard components follow one component per file.
- No axios; use native `fetch`.

## Important non-goals

- No live trade execution.
- No TP/SL.
- No real order submission.
- No mutating web/API endpoints.
- No axios.
