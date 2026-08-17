# Extended execution integration

Official sources: https://api.docs.extended.exchange/ and https://github.com/x10xchange/examples/tree/main/typescript.

## Credentials
`EXTENDED_API_KEY` authenticates read-only requests using `X-Api-Key`. Mutations additionally require `EXTENDED_STARK_PRIVATE_KEY` and `EXTENDED_VAULT_ID`. `EXTENDED_API_BASE_URL` must point to the chosen official environment. Do not log any credential.

## Official model
The official TypeScript examples pin `@x10xchange/stark-crypto-wrapper-wasm@0.1.6` and `starknet@8.5.4`; initialise the wrapper before constructing signed orders. Build market/fee/domain context from `/api/v1/info/markets`, `/api/v1/user/fees`, and `/api/v1/info/starknet`; then POST the signed official order JSON to `/api/v1/user/order`. Read-only account/position/order queries use the API key. Cancel uses `DELETE /api/v1/user/order/{id}`.

## Safety
Execution is default-disabled. Enable only after account, market, BBO, margin, position mode, credentials and signer checks pass. Market orders use IOC/FOK semantics and every emergency close must be reduce-only.

## Implemented endpoints
- `GET /api/v1/info/markets`
- `GET /api/v1/info/markets/{market}/orderbook`
- `GET /api/v1/info/starknet`
- `GET /api/v1/user/fees`
- `GET /api/v1/user/balance`
- `GET /api/v1/user/orders/{id}`
- `GET /api/v1/user/positions`
- `POST /api/v1/user/order`
- `DELETE /api/v1/user/order/{id}`

## Current support in the bot
- Read executable BBO from the orderbook.
- Read market metadata, available margin, order status and positions.
- Submit signed `LIMIT`, `MARKET`, `TPSL` orders using the official Stark signing model.
- Cancel orders by id.

## Verified behavior
`apps/bot/test/extended-execution.test.ts` covers:
- official signing fixture parity,
- IOC crossing market execution,
- reduce-only TP/SL trigger signing,
- order query, cancel and position reads.

## Known limitations
- The bot still keeps global live placement disabled at config level until the full trade-opening workflow is promoted from guarded slice to production.
- Balance `404` is normalized as zero because some accounts/environments do not expose `/api/v1/user/balance`; this is an explicit compatibility fallback in the HTTP client.
