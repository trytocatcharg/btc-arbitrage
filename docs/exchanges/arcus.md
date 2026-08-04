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
| WebSocket market data | documented, not wired | `wss://api.arcus.xyz/v1/ws` |
| Account reads | documented, not wired | Public account endpoints with `address` query parameter |
| Place/cancel/modify order | blocked | Signed REST or WebSocket order endpoints |

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
- Order management and credential-creating endpoints require Ed25519 request signing.
- Authenticated order headers are `X-API-Key`, `X-Timestamp`, and `X-Signature`.
- `X-Timestamp` uses Unix nanoseconds.
- The API key is the hex-encoded Ed25519 public key.
- `ARCUS_API_KEY` is not enough to place orders; live trading stays blocked.
- Any future Arcus signing key is a secret and must never be logged. Do not add it to env/config until live signing is implemented.

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
| `src/exchanges/arcus/arcus-client.ts` | High-level Arcus read-only adapter and trading gate. |
| `src/exchanges/arcus/arcus-http-client.ts` | Native `fetch` HTTP client, query handling, request timeout placeholder. |
| `src/exchanges/arcus/arcus.types.ts` | Request/response shapes used by the adapter. |

## Before live trading

- [ ] Register and validate Ed25519 API key flow on testnet.
- [ ] Implement canonical `ordersign` payload generation or accept only fully prebuilt signed payloads.
- [ ] Verify order sizing with Arcus tick size, step size, margin fractions, and max leverage.
- [ ] Subscribe to WebSocket `orders` and `userFills` before treating orders as filled/canceled.
- [ ] Add a Telegram confirmation step before sending any order.
- [ ] Keep `ARCUS_TRADING_ENABLED=false` until testnet order open/close is verified end-to-end.
