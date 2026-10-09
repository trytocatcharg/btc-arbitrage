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
- `GET /api/trades/volume-stats`
- `GET /api/trades/unhedged/active`
- `GET /api/trades/unhedged/events`
- `GET /api/trades/:id/timeline`

There are no write endpoints.

## Responsibilities

### 1. Health endpoint

- `GET /health` returns `{ status: "ok" }`.

### 2. Exchange balance reads

The backend currently reads balances for:

- **RISEx**
- **Extended**

and returns normalized `ExchangeBalance` / `ExchangeBalancesResponse` payloads from `@btc-arbitrage/domain`.

### 3. Farmed-volume stats (read-only)

`GET /api/trades/volume-stats` returns the DB-backed farmed trading volume
(`volume-farming` / `volume-stats-api` specs):

- lifetime total `sum(trades.filled_notional_usd)`,
- per-venue lifetime totals `sum(trade_legs.filled_notional_usd) group by exchange_id`,
- the same two aggregates for the trailing 24h / 7d / 30d windows, filtered on
  `trades.updated_at` (a trade last written inside the window contributes its
  cumulative volume to that window).

The aggregation lives in `exchanges/volume-stats-service.ts` over the shared
read-only DB handle (`getDb()`), with response normalization in
`exchanges/volume-stats-normalizers.ts` (decimals as strings per the
`formatDecimal` convention). The route performs no order placement and no
exchange signing.

### 4. Unhedged-window observability (read-only)

`GET /api/trades/unhedged/active`, `GET /api/trades/unhedged/events`, and
`GET /api/trades/:id/timeline` expose trade-analysis data for unhedged
windows and per-trade timelines (`unhedged-observability` spec):

- **Active unhedged trades** — every trade in status `unhedged` with its open
  and closed leg, plus `unhedgedSince`. Derivation priority: the latest
  `trade_status_history` row with `to_status = 'unhedged'` (exact,
  `unhedgedSinceApproximate: false`); else the closed leg's `closed_at`
  (approximate); else `trades.updated_at` (approximate).
- **Unhedged events** — one entry per unhedged window: the window starts at a
  monitor-written `trade_status_history` `to_status = 'unhedged'` row
  (`toStatusChangedAtIdx`), ends at the earliest later `closed`/`failed`
  history row for the same trade, and resolves accordingly (`open` when no
  end row exists). Trades that went unhedged before the monitor wrote
  history rows are merged in with `windowStartAt` from the closed leg's
  `closed_at` (or null) and flagged `approximateStart: true`. Invalid
  `limit` (1..200, default 50) or `sinceDays` (1..365, default 90) query
  params fall back to the defaults instead of erroring.
- **Per-trade timeline** — the trade row, both full leg rows, the status
  history ascending by `changed_at`, and the originating signals row (or
  null). A missing or non-integer id returns `404 { error: "Trade not found" }`.

The monitor (`apps/bot/src/trading/trade-monitor.ts`) now writes a
`trade_status_history` row inside the same transaction as every status flip
it performs (`unhedged` and `closed`), tagged `source: "position-monitor"`
in metadata, so unhedged windows are reconstructible from history alone.

PnL convention: `realized_pnl_usd` is GROSS (fee-free). `netPnlUsd` is
`realized − total_fees_usd` and is emitted only when the trade resolved and
`total_fees_usd` is known; NULL fees are never estimated.

The aggregation lives in `trades/trade-analysis-service.ts` over the shared
read-only DB handle (`getDb()`), with response normalization in
`trades/trade-analysis-normalizers.ts` (decimals as raw SQL strings, dates
as ISO strings). The routes perform no order placement and no exchange
calls.

### 5. Error normalization

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
- mutate trade state.

The backend never mutates; the trade-analysis APIs above are read-only
(unhedged windows + per-trade timeline). A paginated all-trades listing
remains a non-goal.
