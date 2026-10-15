# Extended execution integration

Official sources: <https://api.docs.extended.exchange/> and <https://github.com/x10xchange/examples/tree/main/typescript>.

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
- `GET /api/v1/user/leverage?market={market}`
- `PATCH /api/v1/user/leverage`
- `POST /api/v1/user/order`
- `DELETE /api/v1/user/order/{id}`

## Current support in the bot

- Read executable BBO from the orderbook.
- Read market metadata, available margin, order status and positions.
- Submit signed `LIMIT`, `MARKET`, `TPSL` orders using the official Stark signing model.
- Cancel orders by id.
- Preflight aligns the exchange leverage per market via `PATCH /api/v1/user/leverage` (API-key auth, no Stark signature — it is an Account endpoint, not Order management). Exchange rejections (open position + triggered orders too large for the selected leverage, or available balance insufficient for the additional margin) surface as preflight failures, both at startup and on the Telegram `/config` leverage change.

## Leverage alignment and resilience

Behavior documented here is authoritative; code comments only point back to this section.

- **Leverage write**: `validateExecutionPreflight` aligns the exchange leverage with the bot-configured value at every startup and whenever the Telegram `/config` leverage change prepares the exchanges before applying the new value. An exchange rejection keeps the previous config value untouched (same "prepare exchanges before applying" pattern as the Pairs flow).
- **Timeout budget**: every Extended REST call carries a 10 s abort budget. On timeout the client throws an `ExtendedRequestTimeoutError` naming the method, path, and elapsed time, so a multi-call preflight failure identifies the exact hung request.
- **Preflight retry**: the Extended preflight retries all of its checks once when a call times out — every call is idempotent (GET markets, GET balance, PATCH leverage, local WASM init); HTTP rejections and exchange validation failures still fail fast without a retry.
- **Startup retry**: the bot startup preflight retries a full preflight up to 3 attempts with 5 s / 15 s backoff, only for timeout-class errors. Persistent errors (bad credentials, leverage above the market cap, insufficient balance, HTTP error statuses) abort startup immediately — they cannot succeed by re-running. See `specs/exchange-execution.md` for the cross-exchange policy.

## Verified behavior

`apps/bot/test/extended-execution.test.ts` covers:

- official signing fixture parity,
- IOC crossing market execution,
- reduce-only TP/SL trigger signing,
- order query, cancel and position reads.

Order ids are 19-digit integers returned as JSON numbers (> `Number.MAX_SAFE_INTEGER`). `ExtendedHttpClient.parseResponseBody` quotes integer literals of 16+ digits before `JSON.parse` so ids keep their exact digits; without this, trailing digits are corrupted by double precision and every `GET/DELETE /api/v1/user/orders/{id}` for that order 404s. RISEx ids are strings and do not need this treatment.

## Known limitations

- The bot still keeps global live placement disabled at config level until the full trade-opening workflow is promoted from guarded slice to production.
- Balance `404` is normalized as zero because some accounts/environments do not expose `/api/v1/user/balance`; this is an explicit compatibility fallback in the HTTP client.
- **Starknet → Arc migration (published 2026-10-08)**: Extended moves settlement to Arc (Circle's EVM L1) starting **2026-10-22 12:00 UTC**. The integration is Starknet-coupled end to end (base URL `api.starknet.extended.exchange`, Stark WASM signing, Stark private key + vault id, Starknet domain from `/api/v1/info/starknet`); the new API host, signing model, and credentials will very likely change, and Extended had **not published a developer/API migration guide as of 2026-10-15** — re-verify every endpoint (including the leverage PATCH) against the new environment when the guide appears. Operational risk to clear before **2026-10-21 12:00 UTC**: if any sub-account holds more than USD 1 of USDT or wBTC, Extended cancels ALL orders in it (including TP/SL and API orders) and closes positions at mark price; the bot's collateral is USDC, but sub-account balances must be checked, and extra free margin is needed for the deposit/withdrawal pause (~2 h) during the migration.
