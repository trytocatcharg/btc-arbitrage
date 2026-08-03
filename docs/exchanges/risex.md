# RISEx integration spec

This spec captures the RISEx API facts this bot relies on, so trading work is reviewed against documentation instead of memory.

## Source of truth

| Source | URL |
|---|---|
| RISE RISEx docs | https://docs.risechain.com/docs/risex |
| RISEx API reference | https://developer.rise.trade/reference/general-information |
| RISE LLM docs bundle | https://docs.risechain.com/llms-full.txt |

## Bot scope

| Capability | Current state | Endpoint |
|---|---:|---|
| Markets | wired | `GET /v1/markets` |
| Cross-margin balance | wired | `GET /v1/account/cross-margin-balance?account={address}` |
| Portfolio fallback | wired | `GET /v1/portfolio/details?account={address}` |
| Positions | wired | `GET /v1/positions?account={address}` |
| Single position | wired | `GET /v1/account/position?account={address}&market_id={marketId}` |
| Open orders | wired | `GET /v1/orders/open?account={address}` |
| Place order | gated | `POST /v1/orders/place` |
| Cancel order | gated | `POST /v1/orders/cancel` |

## Auth and signing decisions

- Read methods require `RISEX_ACCOUNT_ADDRESS` where the endpoint is account-scoped.
- Trading remains disabled unless `RISEX_TRADING_ENABLED=true`.
- Placing and closing trades requires a prebuilt signed permit. The bot must not invent or partially build a permit in production code.
- `RISEX_PRIVATE_KEY` is a secret and must never be logged.

## Operational constraints

| Constraint | Impact |
|---|---|
| RISEx API docs are marked work-in-progress | Re-check endpoints before enabling live trading. |
| Timestamps are nanoseconds unless the endpoint says otherwise | Do not reuse millisecond timestamps blindly. |
| REST rate limit is 500 requests / 10 seconds per IP | Avoid aggressive polling and add backoff around retries. |

## Implementation map

| File | Responsibility |
|---|---|
| `src/exchanges/risex/risex-client.ts` | High-level RISEx operations and trading gate. |
| `src/exchanges/risex/risex-http-client.ts` | Native `fetch` HTTP client, query handling, request timeout. |
| `src/exchanges/risex/risex-execution-adapter.ts` | Adapter exposed to bot commands/execution ports. |
| `src/exchanges/risex/risex.types.ts` | Request/response and enum shapes used by the adapter. |

## Before live trading

- [ ] Verify current `POST /v1/orders/place` and `POST /v1/orders/cancel` schemas against the official API reference.
- [ ] Implement and test EIP-712 permit signing on testnet.
- [ ] Confirm market ID mapping from scanner symbol to RISEx `market_id`.
- [ ] Add a Telegram confirmation step before sending any order.
- [ ] Keep `RISEX_TRADING_ENABLED=false` until testnet order open/close is verified end-to-end.
