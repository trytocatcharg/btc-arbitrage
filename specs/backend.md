# Backend specification

## Purpose

`apps/backend` is a **read-only HTTP API** for operational data that the web dashboard can consume safely.

It does **not** place orders, does **not** confirm trades, and does **not** own exchange execution.

## Runtime

- Entry point: `apps/backend/src/main.ts`
- Server factory: `apps/backend/src/server.ts`
- Balance orchestration: `apps/backend/src/exchanges/balance-service.ts`

The backend boots by:

1. loading environment variables,
2. loading backend config,
3. creating the balance service,
4. starting an Express server.

## Current HTTP surface

Implemented routes:

- `GET /health`
- `GET /api/exchanges/balances`
- `GET /api/exchanges/risex/balance`
- `GET /api/exchanges/extended/balance`

There are no write endpoints.

## Responsibilities

### 1. Health endpoint

- `GET /health` returns `{ status: "ok" }`.

### 2. Exchange balance reads

The backend currently reads balances for:

- **RISEx**
- **Extended**

and returns normalized `ExchangeBalance` / `ExchangeBalancesResponse` payloads from `@btc-arbitrage/domain`.

### 3. Error normalization

The backend converts exchange failures into safe public responses instead of leaking raw exchange internals to the UI.

Examples already implemented:

- RISEx balance read failures become an error balance payload.
- Extended `404` on `/api/v1/user/balance` is normalized to synthetic zero balance.

## Exchange-specific behavior

### RISEx

- Uses production REST base URL from config.
- Reads cross margin balance from:
  - `GET /v1/account/cross-margin-balance?account=...`
- Requires `RISEX_ACCOUNT_ADDRESS` to read balances.

### Extended

- Reads:
  - `GET /api/v1/user/balance`
- Requires:
  - `EXTENDED_API_KEY`
- Sends `User-Agent` and `x-api-key`.

## Security and architecture boundaries

- Backend is **public/read-only**.
- It must not expose order placement.
- It must not become a web-facing execution API.
- Trade execution authority remains in the bot.

## Non-goals

The backend currently does **not**:

- open or close positions,
- create TP/SL,
- confirm Telegram trade previews,
- mutate trade state,
- expose historical trade APIs yet.
