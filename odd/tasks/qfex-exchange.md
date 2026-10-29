# Feature — QFEX exchange adapter (RWA arbitrage groundwork)

**Motivation**: operator wants a new RWA arbitrage strategy (e.g. AAPL) between QFEX and an existing exchange (e.g. extended). This feature implements the QFEX exchange integration only; the strategy is a follow-up feature.

**Goal**: full `ExchangeAdapter` for QFEX — market data via public REST + execution via WebSocket order entry (`wss://trade.qfex.com`, HMAC-SHA256 auth) with REST user data (positions, trades, balances, fees, leverage). Execution gated behind `QFEX_TRADING_ENABLED=false` default, same posture as the other adapters.

**Non-goals**: the RWA arbitrage strategy itself; WS market-data streaming (bot polls at 1 Hz, `polling-only` capability like the rest); funding/deposit-withdraw endpoints; builder codes; subaccounts (single primary account).

## Key protocol facts (from docs.qfex.com, fetched 2026-11-05)

- REST base: `https://api.qfex.com` (OpenAPI at `/openapi.yaml`, saved to /tmp/qfex-docs/).
- Public market data: `GET /md/contracts`, `GET /md/orderbook/{ticker_id}`, `GET /refdata`, candles, funding historic.
- Private REST: `/user/positions`, `/user/trade`, `/user/subaccounts/balance`, `/user/fees`, `/user/leverage`. Auth scheme per API-key docs (signing details TBD from openapi security schemes).
- Order entry is **WebSocket-only** (`trade.qfex.com`): add_order, cancel_order, modify_order, stop orders (TP/SL), close_position, get_order/get_user_orders, get_user_trades, set_leverage, subscriptions for balance/positions/fills. Auth: HMAC-SHA256 hex of `"${nonce}:${unix_ts}"` with secret, sent in `auth` message within 1 min of connect; nonce unique per 15 min.
- Node runtime note: global `WebSocket` exists on the dev Node (v23); repo floor is Node >= 20.20.1 where it may be behind a flag — worker must verify and fall back to the `ws` package if needed.

## Tasks

1. [x] Domain: add `"qfex"` to `ExchangeId` (`packages/domain/src/index.ts`).
2. [x] Config: `qfex` block in `BotConfig` + parsing (`QFEX_API_BASE_URL`, `QFEX_WS_BASE_URL`, `QFEX_API_KEY`, `QFEX_SECRET_KEY`, `QFEX_ACCOUNT_ID` optional, `QFEX_TRADING_ENABLED`, maker/taker fee bps defaults 1/3) + `parseExchange` allow-list (`packages/config/src/index.ts`). `QFEX_TRADING_ENABLED=true` without both credentials fails config load.
3. [x] QFEX HTTP client + types (`apps/bot/src/exchanges/qfex/`): `qfex-http-client.ts` (public REST market data + private REST with the HMAC header scheme, 10 s timeout, native fetch) and `qfex.types.ts`.
4. [x] Market-data adapter `qfex-client.ts`: `getMarkets`, `getPriceSnapshot` (`index`/`last` only — `PRICE_SOURCE=mark` throws, no REST mark price; fail closed), `getMarketStats` (24h volume left undefined — `base_volume`/`target_volume` window undocumented), `getBestBidOffer` via the execution adapter.
5. [x] WebSocket trade client `qfex-ws-client.ts`: lazy connect + HMAC auth within timeout, correlation by client_order_id/order_id (no request ids in the protocol), command timeout, `err`-frame mapping, lazy auto-reconnect with bounded backoff (1s→30s), `close()`. Uses the `ws` package (repo floor Node 20.20 has no reliable global WebSocket).
6. [x] Execution adapter `qfex-execution-adapter.ts`: full `ExecutionAdapter` contract — BBO (`/md/orderbook/{ticker_id}`), metadata (`/refdata`), margin (`/user/positions` `balance.available_balance`), preflight (leverage set via REST `POST /user/leverage`), submit (limit→ALO GTC post-only, market→MARKET IOC, TP/SL→TAKE_PROFIT/STOP_LOSS triggers, reduce-only required), get/cancel order (WS, in-memory order→symbol map), position (signed `position` → side by sign), account fills (`/user/trade` paginated ≤1000/page, bounded, exact-decimal notional), `resolveLegClosure` (stored TP/SL ids via WS `get_order` + per-order `get_user_trades` VWAP/fee; closing-side `/user/trade` VWAP fallback). Gate: `requireTradingEnabled` + credentials. Exact BigInt decimal math (Extended discipline).
7. [x] Registry: `qfex` registered in `apps/bot/src/exchanges/registry.ts`; routing fee table entry in `apps/bot/src/trading/open-trade-factory.ts`; loud startup warning in `apps/bot/src/main.ts`.
8. [x] Docs: `docs/exchanges/qfex.md` (authoritative spec with the live-verify list), `docs/exchanges/README.md` index entry, `.env.example` QFEX block, AGENTS.md env table rows.
9. [x] Typecheck (`yarn typecheck` from repo root: exit 0, clean) + work-unit commit on feature branch `feature/qfex-exchange` — commit left to the parent/orchestrator per delegation contract.

## Open questions — ALL RESOLVED 2026-11-05 (docs.qfex.com, full read)

- **Private REST auth**: headers `x-qfex-public-key`, `x-qfex-hmac-signature` (hex HMAC-SHA256 of `"${nonce}:${unix_ts}"` with the secret), `x-qfex-nonce` (hex, ≤100 chars, unique per 15 min), `x-qfex-timestamp` (unix seconds). Optional `x-qfex-requested-account-id` (subaccount UUID). Same signing string as the WS auth.
- **Symbol naming**: perp symbols are dash-joined, e.g. `AAPL-USD`, `PLTR-USD` (examples across WS schemas). `/md/contracts` items have `ticker_id`, `base_currency`/`target_currency`, `product_type`. `/refdata` items (`RefdataSymbol`) have `symbol`, `tick_size`, `lot_size`, `min_quantity`, `max_quantity`, `default_max_leverage`, `order_types`, `order_time_in_force`, `underlier_price`, `status`, `product_category`, `market_hours`.
- **Post-only**: ALO order type = add-liquidity-only (cancelled if it would cross); GTC only. LIMIT supports GTC/IOC/FOK. MARKET supports IOC only. (Instruction availability table, order-types.md.)
- **TP/SL**: `add_order` with `order_type` TAKE_PROFIT / STOP_LOSS; `price` = trigger; converts to MARKET when **mark price** reaches trigger; inherently reduce-only (rejected if it would increase position). Alternative: `take_profit`/`stop_loss` fields on any order. Statuses arrive as `order_response` frames.

## Protocol facts (implementation contract)

### REST (`https://api.qfex.com`)
- Public: `GET /md/contracts?symbol=` → `{data: Contract[]}` (fields incl. `ticker_id`, `last_price`, `index_price`, `base_volume`, `target_volume`, `funding_rate`; NO mark price). `GET /md/orderbook/{ticker_id}` → `{ticker_id, timestamp, bids: [[price,size]...], asks: [...]}` (string tuples). `GET /refdata?ticker=` → `{type, data: RefdataSymbol[]}`.
- Private (HMAC headers): `GET /user/positions` → `{positions: PositionPublic[], balance: BalancePublic}` (`position` signed qty, `average_price`, `leverage`, `margin_mode`; `balance.available_balance`). `GET /user/trade?symbol=&limit=(≤1000)&offset=` → `{data: Trade[], count}` (Trade: `price`, `quantity`, `side` BUY/SELL, `fee`, `order_type`, `tif`, `order_id`, `realised_pnl_change`, `order_timestamp`, `liquidation`, `order_origin`). `GET /user/subaccounts/balance` → primary+subaccounts with `available_balance`. `GET /user/fees` → `{fees: {SYMBOL: {maker_fee, taker_fee}}}` (fractions, e.g. 0.0001). `POST /user/leverage` body `{symbol, leverage}`.
- **No mark price in REST** → adapter `supportsPriceSources: ['index','last']`; fail closed if configured `PRICE_SOURCE=mark` (project rule). Documented in qfex.md.

### Trade WebSocket (`wss://trade.qfex.com?api_key=<pub>`)
- Auth within 60 s: `{type:'auth', params:{hmac:{public_key,nonce,unix_ts,signature}}}` → `{authenticated:true}`. Re-auth → `AlreadyAuthenticated`.
- Commands (all `{type, params}`): `add_order` (symbol, side BUY/SELL, order_type LIMIT/MARKET/ALO/TAKE_PROFIT/STOP_LOSS, order_time_in_force GTC/IOC/FOK, quantity, price [LIMIT/ALO only], take_profit?, stop_loss?, client_order_id?), `cancel_order` (symbol, order_id, cancel_order_id_type: order_id|client_order_id|twap_id|client_twap_id), `modify_order`, `get_order` (order_id+symbol), `get_user_orders` (limit/offset/symbol), `get_user_trades` (limit/offset/order_id/start_ts/end_ts), `cancel_stop_order` (stop_order_id), `modify_stop_order`, `cancel_all_orders`, `close_position` (symbol, client_order_id?), `set_user_leverage` (symbol, leverage), `get_user_leverage`, `cancel_on_disconnect` (bool). Subscriptions: `{type:'subscribe', params:{channels:[order_responses|stop_orders|positions|balances|fills]}}`.
- Responses: `order_response` (order_id, symbol, status [ACK|FILLED|CANCELLED|REJECTED|…40+ enum], quantity, price, take_profit, stop_loss, side, type, time_in_force, client_order_id, quantity_remaining, update_time, trade_id?), `fill_response` (trade_id, price, quantity, side, aggressor_side, order_id, fee, order_type, tif, order_price, client_order_id, remaining_quantity, execution_type NEW|LIQUIDATION, timestamp, realised_pnl), `user_trades_response: TradePayload[]` (trade_id, symbol, price, quantity, side, order_id, fee, order_type, tif), `position_response`, `balance_response`, `stop_order_response` (stop_order_id, symbol, price, quantity, direction, stop_order_type TAKE_PROFIT|STOP_LOSS, client_order_id, update_time), `ack`, `subscribed`, `err` (error_code, message, incoming_message echo).
- Correlation: by `client_order_id` / `order_id` inside response frames; errors echo the offending message. No request ids — design the client around correlation keys + timeouts.
- Rate limits: weighted per message type over a sliding window; `RateLimited` → backoff.

### Design decisions
- Execution adapter maps: limit→ALO (post-only, GTC) when reduceOnly=false entry semantics require passive; market→MARKET IOC; take-profit-market→TAKE_PROFIT trigger; stop-market→STOP_LOSS trigger. `ExecutionOrderRequest.reduceOnly` for closes maps to reduce-only-by-construction TP/SL/close_position; a plain reduce-only MARKET is implicit (position-decreasing IOC is limited by position per docs).
- **Correction (verification pass)**: ALO would-cross handling in the entry flow is NOT yet wired — `isPostOnlyRejection` in `open-trade.ts` only recognizes the RISEx/Extended markers (`PostOnlyOrderMatched()`, `POST_ONLY_WOULD_CROSS`), NOT the QFEX `QFEX order was not accepted: status=...` form thrown by `mapSubmittedOrder`, so an ALO would-cross currently fails the entry outright. Any "post-only retry parity" claim is wrong; the wiring stays on the live-verify/follow-up list.
- `resolveLegClosure`: read stored TP/SL order ids via WS `get_order` / REST historic orders; fallback to `GET /user/trade` history (fee + realised_pnl_change per trade, `liquidation` flag).
- `getAccountFills` (/volume): `GET /user/trade` paginated; notional = price×quantity; fee field present.
- WS client: lazy singleton connection per adapter, auto-reconnect with backoff, command timeout, correlation by client_order_id. Node floor 20.20 may lack global WebSocket → use `ws` package if `typeof WebSocket === 'undefined'` (add dep to apps/bot if needed; prefer global first).

### Live-verify later (documented unknowns)
- Whether `get_order` on a triggered/filled TP/SL still resolves (drives resolveLegClosure primary path).
- Whether stop orders appear in `get_user_orders` or only via stop_orders subscription.
- Exact `client_order_id` propagation in fill_response (schema has it; verify).
- ALO would-cross behavior at placement + wiring the post-only retry for the QFEX rejection form (`isPostOnlyRejection` does not recognize it yet — see the correction note in Design decisions).

## Evidence

- Commit: `0817b86` on `feature/qfex-exchange` (18 files, +2334/-6), incl. this task file.
- `yarn typecheck` from repo root: **exit 0, clean** (2026-11-05, after implementation and after fixes).
- `yarn install` after adding `ws@8.18.3` + `@types/ws@8.18.1` to apps/bot: 2 packages added, lockfile updated (dependency add explicitly authorized by the parent task).
- Raw official specs consulted: /tmp/qfex-docs/{openapi.yaml, trade.yaml} (field names verified: Contract, RefdataSymbol, OrderBookResponseBody, PositionPublic/BalancePublic, Trade, AddOrderCommand, OrderResponse enum, ErrResponse, AuthenticateCommand).
- **Live public verification 2026-11-05** (real API calls, no keys needed): `/md/contracts` (234 perps, RWA-only, **no BTC perp** — QFEX cannot join the BTC spread pair), `/md/orderbook/AAPL-USD` (string tuples with **zero-size placeholder levels** → BBO skip-size-0 fix on this branch), `/refdata?ticker=AAPL-USD` (tick 0.01, lot 0.001, min qty 0.01, max lev 20, margin USDC, order_types LIMIT/MARKET/ALO). Private REST + WS order entry remain pending the operator's API keys.
