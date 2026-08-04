# btc-arbitrage

Safe-by-default TypeScript monorepo for monitoring BTC perpetual/futures prices across a configured exchange pair: RISEx, Extended, or Arcus.

## What this slice does

- Monitors BTC price snapshots from the configured exchange pair through read-only adapters: RISEx, Extended, or Arcus.
- Calculates absolute price spread and emits a signal when `absoluteDiffUsd >= MIN_PRICE_DIFF_USD`.
- Sends Telegram alerts when `TELEGRAM_ENABLED=true` and Telegram credentials are configured. Telegram alerts are globally throttled by `TELEGRAM_ALERT_COOLDOWN_MS`; default is one notification per hour.
- Keeps execution in `BOT_EXECUTION_MODE=dry-run` by default. No live order placement is implemented.
- Provides a minimal read-only web scaffold and a base Drizzle/MariaDB schema.

## Monorepo layout

```txt
apps/bot      Node.js + TypeScript monitoring runtime
apps/web      React + Tailwind read-only dashboard scaffold
packages/config
packages/db
packages/domain
packages/exchange-core
packages/shared
```

## First run

```bash
corepack enable
yarn install
cp .env.example .env
yarn typecheck
yarn test
yarn dev:bot
yarn dev:web
```

Set these for Telegram alerts:

```txt
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
TELEGRAM_ALERT_COOLDOWN_MS=3600000
```

Telegram alerts are always sent to the configured `TELEGRAM_CHAT_ID`. The bot also exposes a chat guard for future Telegram inbound handlers; any incoming update must be rejected unless its `chat.id` matches `TELEGRAM_CHAT_ID`.

If your global `yarn --version` is `1.x`, use `corepack yarn <command>` or run `corepack enable` first. The repo is pinned to Yarn 4 through `packageManager`.

Do not commit real credentials. Tokens, private keys, API keys, and DB passwords must never be logged.

In Docker, `Environment file status { loaded: false }` is OK when env vars are injected by Compose/Portainer/Kubernetes instead of a repo `.env` file.

## Safe defaults

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

`RISEX_TRADING_ENABLED`, `EXTENDED_TRADING_ENABLED`, and `ARCUS_TRADING_ENABLED` may exist in the environment, but they are ignored while this is a monitoring-only bot. Real order placement still requires future TP/SL/execution work and stays blocked unless `ENABLE_ORDER_PLACEMENT` is implemented later.

Smoke test one monitoring tick:

```bash
BOT_RUN_ONCE=true TELEGRAM_ENABLED=false READ_API_ENABLED=false yarn dev:bot
```

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
    yarn install &&
    yarn build:bot &&
    yarn start
  "
```

## Exchange contracts

Local specs under `docs/exchanges/` are the repo-level adapter contract. Update those docs before changing adapter behavior or enabling live trading.

Current adapter behavior is fail-safe: if the configured `PRICE_SOURCE` is not present in the exchange market payload, the bot throws an explicit error instead of silently falling back.

## Database

The initial Drizzle schema lives in `packages/db/src/schema.ts`.

```bash
yarn db:generate
yarn db:migrate
yarn db:studio
```

## Important non-goals

- No live trade execution.
- No TP/SL.
- No real order submission.
- No mutating web/API endpoints.
- No axios; use native `fetch`.

## Large-change note

This SDD apply uses the accepted `delivery_strategy=exception-ok`, so this first slice is intentionally larger than the normal 400-line review budget. Future work should still be split by work unit.
