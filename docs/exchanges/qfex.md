# QFEX integration spec

This spec captures the QFEX API facts this bot relies on, so trading work is reviewed against documentation instead of memory. Written from the official docs and the published OpenAPI/AsyncAPI schemas (fetched 2026-11-05); items that still need live verification are listed at the bottom.

## Source of truth

| Source | URL |
|---|---|
| QFEX API reference | https://docs.qfex.com/api-reference/introduction |
| REST OpenAPI schema | https://api.qfex.com/openapi.yaml |
| Trade WebSocket AsyncAPI schema | published under the QFEX docs (trade.yaml) |

## Bot scope

| Capability | Current state | Endpoint |
|---|---:|---|
| Markets / contract data | wired | `GET /md/contracts` (public) |
| Order book (BBO) | wired | `GET /md/orderbook/{ticker_id}` (public) |
| Symbol reference data | wired | `GET /refdata?ticker=` (public) |
| Positions + balance | wired | `GET /user/positions` (private) |
| User trades history | wired | `GET /user/trade?symbol=&limit=&offset=` (private; `/volume` + closure-resolution fallback) |
| Fee schedule | wired (read path) | `GET /user/fees` (private; fractions per symbol) |
| Set leverage | gated | `POST /user/leverage` `{symbol, leverage}` (private REST — no WS needed) |
| Create/cancel/query order | gated | trade WebSocket `add_order` / `cancel_order` / `get_order` |
| Per-order fills (VWAP + fee) | gated | trade WebSocket `get_user_trades` `{order_id}` |

## Connection surfaces

| Surface | Base | Auth |
|---|---|---|
| REST | `https://api.qfex.com` (`QFEX_API_BASE_URL`) | HMAC headers on private endpoints (below) |
| Trade WebSocket (order entry + user data) | `wss://trade.qfex.com?api_key=<public_key>` (`QFEX_WS_BASE_URL`) | `auth` message within 60 s of connect |

## Auth and signing decisions

- Private REST requests carry four headers: `x-qfex-public-key` (the public API key), `x-qfex-nonce` (fresh random hex, ≤100 chars, unique per 15 min — the adapter uses `crypto.randomBytes(16).hex`), `x-qfex-timestamp` (unix seconds), and `x-qfex-hmac-signature` (hex-encoded HMAC-SHA256 of `"${nonce}:${timestamp}"` with the secret). Optional `x-qfex-requested-account-id` (subaccount UUID) selects a non-primary account (`QFEX_ACCOUNT_ID`); omit for the primary account.
- The WebSocket authenticates with `{type:'auth', params:{hmac:{public_key, nonce, unix_ts, signature}}}` — the same signing string as REST — plus optional `account_id`. Success arrives as `{authenticated:true}`; a second auth is rejected with `AlreadyAuthenticated`. Unauthenticated sockets are closed after ~60 s.
- Order entry is **WebSocket-only**; there is no REST order placement endpoint.
- `QFEX_API_KEY` / `QFEX_SECRET_KEY` are secrets and must never be logged.
- Trading is gated: every mutating path throws without `QFEX_TRADING_ENABLED=true` plus both credentials (`requireTradingEnabled` / `requireCredentials` in the execution adapter).

## Symbol mapping

- Bot canonical symbols are quote-suffixed (`BTCUSDT`, `AAPLUSD`); QFEX perp symbols are dash-joined `<BASE>-USD` (`BTC-USD`, `AAPL-USD`).
- The adapter strips the quote (`USDT`/`USDC`/`USD`) to the base asset, forms `<BASE>-USD`, and then **verifies** the form against the payload: a `/md/contracts` row must have `ticker_id == <BASE>-USD`, `base_currency == <BASE>`, `target_currency == USD`; a `/refdata` row must have `symbol == <BASE>-USD`, `base_asset == <BASE>`, `quote_asset == USD`. No match → throw (fail closed, never guess).

## Market data facts

- `GET /md/contracts` → `{data: Contract[]}` with **decimal-string** fields: `ticker_id`, `last_price`, `index_price`, `base_currency`, `target_currency`, `base_volume`, `target_volume`, `funding_rate`, `product_type`, open interest.
- **There is no mark price in the REST surface.** The adapter advertises `supportsPriceSources: ['index','last']` and throws a clear error when `PRICE_SOURCE=mark` is configured for a QFEX leg — never a silent fallback (project rule).
- **Live check 2026-11-05**: 234 `Perpetual` contracts, all RWA-style — US equities (AAPL-USD, NVDA-USD, TSLA-USD, …), ETFs (US500-USD, TLT-USD, …), indices (NIKKEI-USD, KOSPI-USD, …), commodities (GOLD-USD, SILVER-USD, COPPER-USD, …). **There is NO plain BTC perp** — QFEX cannot join the BTC spread pair; the adapter fails closed as designed. Non-USD quotes also exist (e.g. SAMSUNG-KRW, NIFTY-INR): the adapter only maps `<BASE>-USD`. Dotted tickers exist (`BRK.B-USD`) that the base-asset mapping will NOT resolve — keep them out of bot symbols until handled.
- `GET /md/orderbook/{ticker_id}` → `{ticker_id, timestamp, bids: [[price,size]…], asks: […]}` with string tuples; the schema allows null rows, which the adapter skips. **Live orderbooks carry zero-size placeholder levels** (observed on AAPL-USD: `["347.98","0"]`); the BBO read skips size-0 levels.
- **Live refdata check (AAPL-USD)**: `tick_size "0.01"`, `lot_size "0.001"`, `min_quantity "0.01"`, `default_max_leverage 20`, `margin_asset "USDC"`, `order_types ["LIMIT","MARKET","ALO"]` (TAKE_PROFIT/STOP_LOSS are NOT listed here though the trade WS accepts them — TP/SL placement is a live-verify item), `market_hours` carries pre/open/post/weekend sessions.
- `base_volume`/`target_volume` have **no documented 24h window**, so `getMarketStats` returns no `volume24hUsd` (renders "n/d") until verified live — never estimated.
- `/refdata` items (`RefdataSymbol`): `symbol`, `tick_size` (→ `priceTickUsd`), `lot_size` (→ `quantityStepBase`), `min_quantity`, `max_quantity`, `default_max_leverage` (→ `maxLeverage`), `order_types`, `order_time_in_force`, `status`, `product_category`. Position mode is one-way.

## Order entry (trade WebSocket)

- Commands are `{type, params}` frames; responses are single-key frames (`order_response`, `stop_order_response`, `user_trades_response`, `ack`, `err`, `authenticated`, …). **The protocol has no request ids** — correlation is by `client_order_id` / `order_id` inside the response frame; `err` frames echo the offending message in `incoming_message`. The client matches `err` frames by correlation token, then by command type, then (single in-flight command) by elimination.
- `add_order` params: `symbol`, `side` BUY/SELL, `order_type` LIMIT/MARKET/ALO/TAKE_PROFIT/STOP_LOSS, `order_time_in_force` GTC/IOC/FOK, `quantity`, `price` (LIMIT/ALO only), optional `take_profit`/`stop_loss`/`client_order_id`.
- Bot mapping (mirrors the Extended posture):
  - limit → **ALO + GTC** (add-liquidity-only: cancelled if it would cross — the post-only posture the entry flow requires). Price rounded to `tick_size` — buys down, sells up, so rounding never lifts the price across the book.
  - market → **MARKET + IOC**.
  - take-profit-market → **TAKE_PROFIT**, `price` = trigger; stop-market → **STOP_LOSS**, `price` = trigger. Both trigger on the **mark price** and convert to MARKET; both are **inherently reduce-only** (rejected if they would increase the position). The adapter requires `triggerPriceUsd` + `reduceOnly` for these types.
- `cancel_order` params: `symbol`, `order_id`, `cancel_order_id_type: order_id|client_order_id|twap_id|client_twap_id`.
- `get_order` requires `order_id` **and** `symbol` — the adapter records the symbol of every submitted order id in memory to serve the id-only `ExecutionAdapter` port.
- `order_response.status` is a 40+-value enum. Adapter mapping: `ACK`/`MODIFIED` → new, `IOC_PARTIALLY_FILLED` → partially_filled, `FILLED` → filled, `CANCELLED`/`CANCELLED_STP`/`EXPIRED`/`IOC_CANCELLED` → cancelled, **everything else** (the `REJECTED*` / `INVALID_*` / `NOT_FOUND` / `FAILED_MARGIN_CHECK` / `RATE_LIMITED` family) → rejected. A non-accepted status on the submit response throws immediately as `QFEX order was not accepted: status=...`. **ALO would-cross handling in the entry flow is NOT yet wired**: `isPostOnlyRejection` (`open-trade.ts`) only recognizes the RISEx/Extended markers (`PostOnlyOrderMatched()`, `POST_ONLY_WOULD_CROSS`), NOT this QFEX form, so an ALO would-cross currently fails the entry outright — the post-only retry wiring is a live-verify/follow-up item (below).
- `order_response` carries no fee and its `price` is the **order** price, not the average fill. Exact per-order fill data (VWAP + real fee) is recovered via `get_user_trades {order_id}` once the order is terminal, memoized per order id (Arcus `/v1/fills` parity).
- Rate limits are weighted per message type; a `RateLimited` `err` surfaces as a `QfexWsError` with `errorCode: "RateLimited"`.
- The WS client connects lazily on first command, re-auths and resubscribes after a drop, rejects in-flight commands on connection loss, and reconnects with bounded backoff (1 s → 30 s cap) paid by the next command — an idle bot holds no socket.

## REST user data facts

- `GET /user/positions` → `{positions: PositionPublic[], balance: BalancePublic}`. `position` is a **signed** quantity (positive = long, negative = short); `average_price` is the entry price; `balance.available_balance` is the available margin. All quantities are JSON numbers.
- `GET /user/trade?symbol=&limit=(≤1000)&offset=` → `{data: Trade[], count}`. `Trade`: `price`, `quantity`, `side` BUY/SELL, `fee` (real per-trade fee), `order_id`, `order_type`, `tif`, `order_timestamp` (unix seconds, fractional), `realised_pnl_change`, `liquidation` (opaque string, no documented enum), `order_origin`. The endpoint's ordering is not documented — the adapter sorts newest-first client-side.
- `POST /user/leverage {symbol, leverage}` sets leverage via REST (the startup preflight uses it; no WS needed).

## Fee / PnL conventions

- Routing fee inputs are env-configured (`QFEX_MAKER_FEE_BPS` / `QFEX_TAKER_FEE_BPS`, defaults 1 / 3). `GET /user/fees` returns per-account fractions per symbol (`maker_fee`, `taker_fee`, e.g. 0.0001) for live reconciliation.
- **`realised_pnl_change` fee convention is UNVERIFIED** (whether the exit fee is netted into it is unknown). Per the exchange-agnostic accounting invariant (see README.md), the adapter never surfaces it as `realizedPnlUsd`: bot-derived GROSS from entry/exit/qty stays canonical, and the canonical net is `realized − total_fees_usd`.
- `fee` fields (per trade, per fill) are real values and are surfaced as-is — never estimated. Fees stay `undefined` when the payload does not expose them.
- `resolveLegClosure` primary path: stored TP/SL order ids via WS `get_order` (a fired trigger reports `FILLED`) + `get_user_trades {order_id}` for the exact VWAP/fee. Fallback (manual close / operator-moved trigger, which cancels the protections unfired): closing-side `GET /user/trade` history walked newest-first until the leg quantity is covered (exact-decimal VWAP + summed fee; partial coverage under 50% yields null). `liquidation === "TRUE"|"YES"|"LIQUIDATION"|"1"` marks a liquidation close; anything else stays `manual`.

## Known limitations

- `getMarkets()` currently resolves the BTC contract only (same posture as the Extended adapter); multi-symbol listing arrives with the RWA strategy work.

## Live-verify list (before enabling QFEX_TRADING_ENABLED)

- [ ] Whether `get_order` on a triggered/filled TP/SL still resolves (drives the `resolveLegClosure` primary path).
- [ ] Whether TP/SL placement answers with `order_response` or `stop_order_response` (the adapter handles both; confirm the id type used for later `cancel_order` — stop orders may require `cancel_stop_order {stop_order_id}`).
- [ ] Whether stop orders appear in `get_user_orders` or only via the `stop_orders` subscription.
- [ ] Exact `client_order_id` propagation in `fill_response` / `order_response` frames (schema has it; verify).
- [ ] Whether `base_volume` / `target_volume` are 24h windows (unlocks `volume24hUsd`).
- [ ] The `liquidation` string's actual values on liquidation trades.
- [ ] ALO would-cross behavior at placement (rejection status vs async cancel) — the entry retry loop depends on it, and the post-only retry is NOT yet wired for QFEX (`isPostOnlyRejection` does not recognize the `QFEX order was not accepted: status=...` form).
- [ ] `realised_pnl_change` fee convention (documented above as unverified).

## Implementation map

| File | Responsibility |
|---|---|
| `src/exchanges/qfex/qfex-client.ts` | Market-data `ExchangeAdapter` (contracts snapshot, price source guard). |
| `src/exchanges/qfex/qfex-http-client.ts` | Native-`fetch` REST client, HMAC auth headers, 10 s timeout. |
| `src/exchanges/qfex/qfex-ws-client.ts` | Trade WebSocket client: lazy connect, HMAC auth, correlation, timeout, reconnect. |
| `src/exchanges/qfex/qfex-execution-adapter.ts` | Full `ExecutionAdapter` (BBO, metadata, margin, preflight, submit/get/cancel, position, fills, closure resolution). |
| `src/exchanges/qfex/qfex-symbol.ts` | Fail-closed bot-symbol ↔ `<BASE>-USD` resolution. |
| `src/exchanges/qfex/qfex.types.ts` | Config + REST/WS payload shapes. |
