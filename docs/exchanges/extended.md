# Extended integration spec

This spec captures the Extended API facts this bot relies on, so trading work is reviewed against documentation instead of memory.

## Source of truth

| Source | URL |
|---|---|
| Extended API documentation | https://api.docs.extended.exchange/#extended-api-documentation |
| Extended Python SDK references | linked from the official API documentation |

## Bot scope

| Capability | Current state | Endpoint |
|---|---:|---|
| Markets | wired | `GET /api/v1/info/markets` |
| Balance | wired | `GET /api/v1/user/balance` |
| Positions | wired | `GET /api/v1/user/positions` |
| Open orders | wired | `GET /api/v1/user/orders` |
| Create/edit order | gated | `POST /api/v1/user/order` |
| Cancel order | blocked | `DELETE /api/v1/user/order?id={id}` or `DELETE /api/v1/user/order?externalId={externalId}` |

## Auth and signing decisions

- Read-only private endpoints use `X-Api-Key` from `EXTENDED_API_KEY`.
- Extended requires a `User-Agent` header for REST/WebSocket requests.
- Write operations require both API key and valid Stark signature.
- The API key alone cannot create orders, transfer funds, or withdraw assets.
- The bot only accepts a complete prebuilt signed order payload under `exchangePayload.extended.order`; it sends that body unchanged after invariant checks.
- `EXTENDED_STARK_PRIVATE_KEY` is a secret and must never be logged.

## Endpoint behavior to preserve

| Behavior | Bot handling |
|---|---|
| `GET /api/v1/user/balance` returns `404` when authenticated balance is zero | Normalize to synthetic zero balance for `/balance`. |
| Order creation is asynchronous | Do not treat REST acceptance as guaranteed fill; use order/position checks afterward. |
| Market orders still require a price | Future trade builder must calculate a bounded crossing price; do not omit price. |
| GTT expiry max differs by network | Keep configurable expiry and validate before sending. |

## Implementation map

| File | Responsibility |
|---|---|
| `src/exchanges/extended/extended-client.ts` | High-level Extended operations and trading gate. |
| `src/exchanges/extended/extended-http-client.ts` | Native `fetch` HTTP client, auth headers, request timeout. |
| `src/exchanges/extended/extended-execution-adapter.ts` | Adapter exposed to bot commands/execution ports. |
| `src/exchanges/extended/extended.types.ts` | Request/response and order payload shapes used by the adapter. |

## Before live trading

- [ ] Generate Stark signatures using the official SDK/reference implementation.
- [ ] Verify settlement payload fields: signature, stark key, collateral position, nonce, fee, expiry.
- [ ] Confirm scanner symbol to Extended market mapping.
- [ ] Add a Telegram confirmation step before sending any order.
- [ ] Keep `EXTENDED_TRADING_ENABLED=false` until testnet order open/close is verified end-to-end.
