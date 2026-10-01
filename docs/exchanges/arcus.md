# Arcus integration spec

This spec captures the Arcus API facts this bot relies on, so trading work is reviewed against documentation instead of memory.

## Source of truth

| Source | URL |
|---|---|
| Arcus Docs | https://docs.arcus.xyz/ |
| Arcus docs index | https://docs.arcus.xyz/llms.txt |
| REST introduction | https://docs.arcus.xyz/api-reference/introduction.md |
| Markets endpoint | https://docs.arcus.xyz/api-reference/public/get-markets.md |
| Live prices endpoint | https://docs.arcus.xyz/api-reference/public/get-live-prices-for-all-markets.md |
| BBO endpoint | https://docs.arcus.xyz/api-reference/public/get-best-bid-offer-bbo.md |
| Perpetual prices concept | https://docs.arcus.xyz/concepts/perpetuals/prices.md |

## Bot scope

| Capability | Current state | Endpoint |
|---|---:|---|
| Markets | wired | `GET /v1/markets?market=BTC-USD` |
| Mark/oracle prices | wired | `GET /v1/prices` |
| Last trade price | wired | `GET /v1/markets?market=BTC-USD` |
| Best bid/ask | wired | `GET /v1/bbo/BTC-USD` |
| All live prices | wired | `GET /v1/prices` |
| Account reads (margin, positions, order status) | wired | `GET /v1/account`, `GET /v1/positions`, `GET /v1/order/{orderId}` |
| Place/cancel order (Ed25519 signed) | wired | `POST /v1/placeOrder`, `POST /v1/cancelOrder` |
| Set leverage | wired (bot startup) | `POST /v1/setLeverage` |
| WebSocket market data | documented, not wired | `wss://api.arcus.xyz/v1/ws` |

## Market mapping

| Bot symbol | Arcus market |
|---|---|
| `BTCUSDT` | `BTC-USD` |
| `BTCUSDC` | `BTC-USD` |
| `BTCUSD` | `BTC-USD` |

The adapter reports normalized symbol `BTCUSD`, external market id from `marketId`, and market type `perpetual`.

## Price-source mapping

| Bot `PRICE_SOURCE` | Arcus field | Notes |
|---|---|---|
| `mark` | `markPrice` | Preferred. Arcus docs define mark as the risk/PnL/liquidation reference. |
| `index` | `oraclePrice` | Arcus uses oracle as the external underlying reference. |
| `last` | `lastTradePrice` | Observed in live `GET /v1/markets?market=BTC-USD` responses; not guaranteed by the OpenAPI schema. Prefer `mark`. |

If the selected source is missing or returns `0`, the adapter must throw instead of silently falling back.

## Auth and signing decisions

- Public market-data reads do not require auth.
- Account-scoped reads (`GET /v1/account`, `GET /v1/positions`, `GET /v1/order/{orderId}`) are public: `?address=` query parameter only, no signature, no `X-API-Key` required.
- Order management requires Ed25519 request signing.
- Authenticated order headers are `X-API-Key`, `X-Timestamp`, and `X-Signature`.
- `X-Timestamp` uses Unix nanoseconds (decimal string; ±30 s server skew; millisecond values are rejected with 401).
- The API key is the hex-encoded Ed25519 public key.
- `ARCUS_API_KEY` is not enough to place orders; a signing secret (`ARCUS_PRIVATE_KEY`, 32-byte Ed25519 seed hex) is required and live trading stays behind `ARCUS_TRADING_ENABLED=false`.
- Any future Arcus signing key is a secret and must never be logged.

## Execution facts (pinned 2026-09 from docs.arcus.xyz)

These facts are the contract for `arcus-execution-adapter.ts` and `arcus-signing.ts`.

### Signing schemes

| Operation | Scheme |
|---|---|
| `placeOrder` (op=1), `cancelOrder` (op=2), TPSL placement (op=4) | Scheme 1 — the signed message IS the canonical JSON payload itself: key-sorted, no whitespace, engine-native integers. `ad` is lowercased; every other string is signed byte-for-byte as sent; `c` (clientId) omitted when empty. |
| `setLeverage`, `cancelAllOrders` | Scheme 2 — `ed25519(timestamp + action + canonicalJSON(body))`, action = camelCase final path segment; HTTP method not signed. |

Scheme 1 payload fields: `ad` (address), `ai` (accountIndex), `c` (clientId, optional), `ct` (client timestamp ns = `X-Timestamp`), `g` (goodTilTime in **ns**), `m` (marketId), `op`, `p` (price in integer ticks = price ÷ `tickSize`, exact division), `q` (quantity in integer quantums = size ÷ `stepSize`, exact), `r` (reduce-only 0/1), `s` (side 0=buy/1=sell), `t` (TIF 0=GTT/1=FOK/2=IOC/3=ALO), `v`=1. Cancel payload: `ad`,`ai`,`c` or `id`,`ct`,`m`,`op`:2,`v` (exactly one of `id`/`c`).

> **BigInt requirement**: `ct`/`g` nanosecond values exceed `Number.MAX_SAFE_INTEGER`. The canonical serializer must emit big integers as raw JSON literals (custom serializer, never `JSON.stringify` on numbers).

### Order request (REST body, `POST /v1/placeOrder?address=`)

Required: `address`, `marketId`, `accountIndex`, `orderSide` (BUY/SELL), `orderType` (LIMIT/MARKET), `quantity` (human-readable base units), `price` (human-readable USD), `timeInForce` (GTT/FOK/IOC/ALO), `timestamp` (int64 **ns**, must equal `X-Timestamp`). Optional: `clientId` (charset `[A-Za-z0-9_-]`, max 36 chars), `reduceOnly` (default false), `goodTilTime` (epoch **microseconds** string), `stopPrice`, `tpslType` (STOP_LOSS/TAKE_PROFIT), `isPositionTPSL`, `parentOrderId`, `minSize`. Single-order `signature` field is omitted (signature travels in `X-Signature`).

Hard rules:

- `goodTilTime` is required on **every** order including IOC/FOK, must be ≥ 1 month in the future; the engine cancels the order at expiry. Bot uses ~90 days (`ARCUS_ORDER_EXPIRATION_DAYS`).
- MARKET orders require `price` as a protective slippage bound within 10% of current mark price; TPSL MARKET within 10% of `stopPrice`.
- TPSL orders: `tpslType` + `stopPrice` + `reduceOnly: true` mandatory, `timeInForce` must be GTT. At most one position-level TP and one SL per account+market (`POSITION_TPSL_ALREADY_EXISTS`).
- Post-only is TIF `ALO`; crossing an ALO rejects with `POST_ONLY_WOULD_CROSS` (retryable, same semantics Extended uses).
- Limit-price divisor is always top-level `tickSize`; `tickTiers` only constrain which prices are accepted.
- Placement is async: HTTP 202 = ACK (no terminal state), HTTP 200 = best-effort definitive state. Definitive state requires polling `GET /v1/order/{orderId}` (no WebSocket in the bot yet).
- `clientId` max 36 chars — the bot's `${uuid}-tp`/`-limit2` ids (39–45 chars) are normalized at the adapter boundary to a deterministic `prefix-digest` form (sha256, charset-safe, retry-stable); never truncate the head (tp/sl/hedge of one token would collide).
- Single-order REST bodies (place/cancel) are long-form human-readable fields with `timestamp` as a nanosecond **string**; the Scheme-1 payload is signing input only and never travels as the HTTP body.

### Read endpoints used by execution

| Endpoint | Use | Key fields |
|---|---|---|
| `GET /v1/account?address=` | Available margin | `freeCollateral`, `equity` (404 until first deposit) |
| `GET /v1/positions?address=&market=BTC-USD` | Position polling | `positions` map keyed by marketId: `size` (signed), `averageEntryPrice`, `markPx`, `leverage`, `marginMode` |
| `GET /v1/order/{orderId}?address=` | Order polling + leg-closure recovery | `status` (OPEN/PARTIALLY_FILLED/FILLED/CANCELED/REJECTED/UNTRIGGERED/TPSL_*), `originalSize`, `filledSize`, `remainingSize`, `avgFillPrice`, `rejectionReason`. No per-order fee field → `feeUsd` stays undefined, never estimated. |
| `GET /v1/markets?market=BTC-USD` | Metadata | `tickSize`, `stepSize`, `minOrderSize`, `maxOrderSize`, `minOrderNotional` (opening orders only; reduce-only exempt). No `maxLeverage` field — leave `maxLeverage` undefined. |
| `POST /v1/setLeverage?address=` | Startup leverage set | Body `{address, marketId, leverage, accountIndex?}`; Scheme 2; response `status` APPLIED/ACK/REJECTED (202 ACK is not failure). |

### Fees

Perp fee tiers are not yet final on Arcus; the live schedule is `GET /v1/feetiers`. Routing fee inputs come from env (`ARCUS_MAKER_FEE_BPS` / `ARCUS_TAKER_FEE_BPS`) and must be reconciled against `/v1/feetiers` before enabling live trading.

## Endpoint behavior to preserve

| Behavior | Bot handling |
|---|---|
| `GET /v1/markets` returns `markets[]` and can filter by market name. | Query `market=BTC-USD` for monitoring. |
| `GET /v1/prices` is keyed by stringified numeric `marketId`. | Use for `mark` and `index` monitoring because Arcus documents it as safe to poll frequently. |
| `GET /v1/bbo/{market}` returns nullable `bestBid` / `bestAsk`. | Preserve missing bid/ask as `undefined`; do not fail price monitoring if BBO side is null. |
| BBO timestamp is epoch microseconds. | Convert to JavaScript milliseconds before storing `exchangeTimestamp`. |
| `markPrice` value `0` means no mark price has been received. | Refuse fallback to oracle when `PRICE_SOURCE=mark`. |
| Order submission is asynchronous. | Future execution must observe orders/fills over WebSocket before considering an order terminal. |

## Implementation map

| File | Responsibility |
|---|---|
| `src/exchanges/arcus/arcus-client.ts` | High-level Arcus adapter; wires market data + execution. |
| `src/exchanges/arcus/arcus-http-client.ts` | Native `fetch` HTTP client: GET (public/private), signed POST with `X-API-Key`/`X-Timestamp`/`X-Signature`, 10 s timeout. |
| `src/exchanges/arcus/arcus.types.ts` | Request/response shapes used by the adapter. |
| `src/exchanges/arcus/arcus-signing.ts` | Ed25519 signing: canonical Scheme 1 typed payloads (op 1/2/4) and Scheme 2 legacy messages, BigInt-safe canonical JSON. |
| `src/exchanges/arcus/arcus-execution-adapter.ts` | `ExecutionAdapter` implementation: BBO, metadata, margin, preflight, submit/get/cancel, position, leg-closure recovery. |

## Before live trading

- [x] Canonical `ordersign` payload generation (Scheme 1 + Scheme 2, BigInt-safe).
- [x] Telegram confirmation step (bot-wide preview confirm flow, Arcus included).
- [ ] Register and validate Ed25519 API key flow on testnet (key registration itself is a manual/web-app step: `POST /v1/createApiKey` is ECDSA-signed by the master Ethereum address and not implemented in the bot).
- [ ] Verify order sizing with Arcus tick size, step size, margin fractions on testnet.
- [ ] Reconcile `ARCUS_MAKER_FEE_BPS`/`ARCUS_TAKER_FEE_BPS` against `GET /v1/feetiers`.
- [ ] Subscribe to WebSocket `orders`/`userFills` before treating orders as terminal (until then the bot polls `GET /v1/order/{orderId}`).
- [ ] Keep `ARCUS_TRADING_ENABLED=false` until testnet order open/close is verified end-to-end.
