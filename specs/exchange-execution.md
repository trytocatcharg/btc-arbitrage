# Exchange execution specification

See `docs/exchanges/risex-integration.md` and `docs/exchanges/extended-execution.md`.

## Architecture ownership

- Live trade execution is owned by the bot process, not by the public backend or the web app.
- Telegram is the only allowed operator surface for opening trades.
- Current verified flow:
  - `apps/bot/src/notifications/telegram-command-poller.ts`
  - `apps/bot/src/trading/open-trade.ts`
  - exchange adapters under `apps/bot/src/exchanges/*`
- Backend responsibility remains read-only / reporting for now:
  - `apps/backend/src/server.ts` exposes health and balance reads only.
- Web must remain read-only and must not expose order-entry or trade-confirm mutation paths.

### Rationale

- The codebase already executes the open-trade workflow inside the bot after Telegram confirmation.
- Keeping execution out of backend/web reduces attack surface and avoids duplicating execution authority.
- If execution is later centralized, it must be done through a private internal service called only by the bot, never through public web-facing endpoints.

## Support matrix

### RISEx
- Implemented:
  - market metadata
  - executable BBO from orderbook
  - available margin
  - leverage preflight
  - signed place/cancel
  - open-order lookup
  - position lookup
  - adapted local RISEx SDK for signing and exchange mutations
- Verified by: `apps/bot/test/risex-execution-adapter.test.ts`.
- Local SDK lives in:
  - `apps/bot/src/exchanges/risex/sdk/InfoClient.ts`
  - `apps/bot/src/exchanges/risex/sdk/ExchangeClient.ts`
  - `apps/bot/src/exchanges/risex/sdk/signing/*`
  - `apps/bot/src/exchanges/risex/sdk/types/*`
- Adaptation rule:
  - copy only RISEx types, signing, and model/client pieces needed for our bot execution path
  - do not import the full external repo into runtime ownership
- Verified integration behavior:
  - RISEx `/v1/markets` is valid for `mark_price` / `index_price` / `last_price`, but not for executable BBO
  - executable BBO must be read from `GET /v1/orderbook?market_id=...&limit=1`
  - leverage updates go through the adapted `ExchangeClient`
  - signed order placement goes through the adapted `ExchangeClient`
  - signed cancel goes through the adapted `ExchangeClient`
  - RISEx permit payload uses `permit`
  - permit nonce uses the current `nonce_anchor` from nonce-state for trading permits
  - non-numeric bot `clientOrderId` values must be normalized before signing because RISEx order encoding expects a numeric `client_order_id`
- Newly documented but not yet implemented: TP/SL endpoints `POST /v1/orders/tpsl`, `GET /v1/orders/tpsl`, `POST /v1/orders/tpsl/cancel`.
- TP/SL blocker: the public docs describe request body enums as strings but the EIP-712 signature fields as `uint8`, without publishing the canonical enum encodings. We must not ship TP/SL signing until that mapping is verified against official code or a testnet fixture.

### Extended
- Implemented: market metadata, executable BBO, available margin, fees, Stark domain, signed `LIMIT` / `MARKET` / `TPSL`, order lookup, cancel, position lookup.
- Verified by: `apps/bot/test/extended-execution.test.ts`.
- Compatibility fallback: `/api/v1/user/balance` HTTP 404 is normalized to zero balance.

## Guardrails
- Both integrations stay exchange-flag disabled by default.
- No code may invent undocumented exchange mutation endpoints.
- Any new mutation path must be backed by official docs or official reference code plus mocked signature/HTTP tests.
- Order execution authority must stay in the bot unless an explicit architecture change moves it to a private internal execution service.
- Telegram is the only approved surface for opening operations; web order entry is forbidden in the current architecture.
- Backend public HTTP routes must stay read-only unless the user explicitly approves a new private execution architecture.
- Unit-test work is paused by explicit user instruction as of 2026-08-16; do not add or expand unit tests unless the user explicitly re-enables them.
