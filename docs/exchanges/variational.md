# Variational integration spec

Exchange id: `variational` | Display name: `Variational` | Mode: polling-only (WebSocket endpoint is deprecated upstream)

Source of truth for the API contract: the Python reference bot `variational-bot/` (`modules/core/variational_client.py`, `modules/core/constants.py`, `modules/helpers/price_manager.py`, `modules/helpers/market_limits.py`). Official frontend origin: `https://omni.variational.io`. Chain: Arbitrum (`chainId: 42161`), settlement asset USDC.

## Environments and base URLs

| Purpose | URL | Auth |
| --------- | ----- | ------ |
| Authenticated REST | `https://omni.variational.io/api` | SIWE JWT (cookie `vr-token` + header/cookie `vr-connected-address`) |
| Public market data | `https://omni-client-api.prod.ap-northeast-1.variational.io` | none |
| WebSocket | `wss://omni-ws-server.prod.ap-northeast-1.variational.io` | **deprecated upstream — do not implement** |

No testnet exists. All integration testing happens against mainnet with dry-run mode and zero balances.

## Bot scope

| Capability | Endpoint | State |
| ------------ | ---------- | ------- |
| Markets / metadata | `GET /markets` (fallback: public stats) | wired |
| Price snapshot (mark + BBO) | `GET {PRICE_API}/metadata/stats` | wired (cached, see rate limits) |
| Best bid/offer for execution | `POST /quotes/indicative` | wired |
| Market order (RFQ accept) | `POST /quotes/accept` | wired |
| Limit order | `POST /orders/new/limit` | wired |
| Stop-loss (SL) | `POST /orders/new/limit` with `order_type: "stop_loss"` | wired |
| Take-profit (TP) | — | **blocked: no TP order type exists upstream** (only `stop_loss`). Same blocker category as RISEx (see `specs/exchange-execution.md`). |
| Cancel | `POST /orders/cancel` | wired |
| Order status | `GET /orders/v2` (no query params; filter locally by `rfq_id`) | wired |
| Positions | `GET /positions` | wired |
| Balance / margin | `GET /account/balance` (fallback `GET /portfolio`) | wired |
| Candles | `GET /candles` | **not wired** — upstream contract uncertain (4 parameter formats observed in reference, comments say it "appears to have changed") |

## Market mapping

Variational does not use symbol strings; instruments are objects everywhere:

```json
{ "underlying": "BTC", "instrument_type": "perpetual_future", "settlement_asset": "USDC", "funding_interval_s": 3600 }
```

- Bot symbol `BTCUSDT` (any `BTC*`) → underlying `BTC` (base-asset mapping, same approach as `toArcusMarketName`).
- Only `marketType: 'perpetual'` is supported; anything else throws.
- Quantity limits come from per-ticker `bid_limits` / `ask_limits`: `min_qty`, `min_qty_tick` (quantity step), `max_qty`. No price tick size field exists.
- Numbers are frequently JSON **strings** — parse with `parseDecimal`, never `Number()` directly on raw payloads.

## Price-source mapping (fail-closed)

| `PRICE_SOURCE` | Source field | Notes |
| ---------------- | -------------- | ------- |
| `mark` | `listings[].mark_price` | primary |
| `index` | — | **not available → throw** |
| `last` | — | **not available → throw** |

BBO: `quotes.size_1k.bid` / `quotes.size_1k.ask`, fallback `size_100k`. These are RFQ spreads, not an order book — there is no orderbook endpoint.

**Rate limits:** the public stats endpoint is documented at **10 requests / 10 s / IP**. The bot polls every 1 s, so the adapter MUST cache the stats payload with a short TTL (2–5 s, config `VARIATIONAL_PRICE_CACHE_TTL_MS` default 5000) and serve snapshots from cache. This mirrors the reference bot's 5 s cache.

## Auth and signing

SIWE login, no API keys, no per-request HMAC:

1. `POST /auth/generate_signing_data` `{ "address": "0x..." }` → SIWE message text + nonce.
2. `personal_sign` the message with the account private key (`@noble/curves` secp256k1, already a project dependency). Signature hex **without** `0x`.
3. `POST /auth/login` `{ "address", "signed_message", "code"? }`.
   - Referral code: brand-new wallets **require** one (`400 "no existing referral code found for this user"`); wallets already associated with a code must omit it (`400 "Referee is already associated with a different referral code"` → retry without `code`).
   - JWT from response body field `"token"` or `"jwt"` (fallback: `vr-token` Set-Cookie). Client-side lifetime assumption: 7 days; re-login on 401.
4. Every authenticated request sends: cookie `vr-token=<JWT>`, header `vr-connected-address: 0x...`, cookie `vr-connected-address=0x...`, plus `Content-Type`/`Accept: application/json`, stable `User-Agent`, `Origin`/`Referer: https://omni.variational.io`.

Config: `VARIATIONAL_ACCOUNT_PRIVATE_KEY` (required for trading or balance reads), `VARIATIONAL_REFERRAL_CODE` (optional; only used on first login of a fresh wallet). `VARIATIONAL_ACCOUNT_ADDRESS` may be derived from the key but is kept as an optional override for parity with other exchanges.

Gasless deposit via EIP-712 USDC Permit (`/token/nonce`, `/token/allowance`, `/account/deposit_with_permit`, spender `0xce94caf3d9ef916d2e4a83913fd899b1cd152fa2`) is documented in the reference but **out of scope** — the bot never moves funds.

**Cloudflare risk:** the reference uses `curl_cffi` with Chrome TLS fingerprint impersonation. Native `fetch` may trigger Cloudflare challenges (403/503 + Turnstile markers). The reference currently works without solving challenges. If challenges appear in TS, surface a clear error; do not embed a captcha-solver.

## Execution adapter mapping

| `ExecutionAdapter` method | Implementation |
| --------------------------- | ---------------- |
| `getBestBidOffer` | `POST /quotes/indicative` `{ instrument, qty }` → `bid`/`ask`/`mark_price`. Response may be a single-element JSON **list** — unwrap `[0]`. |
| `getMarketMetadata` | limits from market data (`min_qty`, `min_qty_tick`); `maxLeverage` unavailable upstream → omit. |
| `getAvailableMarginUsd` | `GET /account/balance` field `available` (fallback `/portfolio.balance`). |
| `validateExecutionPreflight` | balance read + symbol/limits check; leverage cap not enforceable upstream. |
| `submitExecutionOrder` | `limit` → `POST /orders/new/limit` `{ order_type:"limit", instrument, side, qty, limit_price, is_reduce_only }`. `market` → RFQ 2-step: `quotes/indicative` then `POST /quotes/accept` `{ quote_id, side, max_slippage, is_reduce_only }`. `stop-market` → `POST /orders/new/limit` `{ order_type:"stop_loss", trigger_price, use_mark_price:true, is_auto_resize:true, is_reduce_only:true }`. `take-profit-market` → **throw** (unsupported upstream). |
| `getExecutionOrder` | `GET /orders/v2` → local filter by `rfq_id` (unwrap `result`/`orders` wrappers). |
| `cancelExecutionOrder` | `POST /orders/cancel` `{ rfq_id }`. |
| `getPosition` | `GET /positions` (3× exponential retry, as reference). |

Gate: `requireTradingEnabled()` / `requireTradingCredentials()` pattern (throws unless `VARIATIONAL_TRADING_ENABLED=true` + private key present), matching risex/extended.

**Open-trade flow fit:** the passive limit entry (post-only retry on `PostOnlyOrderMatched`) assumes classic orderbook semantics. Variational limit orders are REST-only; whether the API rejects/post-only-errors a crossing limit is unverified. Treat first live execution as a smoke test with minimal size; do not assume `PostOnlyOrderMatched` exists — if it never occurs, unfilled-limit retry degrades to timeout cancel, which the flow already handles.

**Fees for routing:** real cost is the RFQ spread (`base_spread_bps` in stats), not a fee schedule. Add `VARIATIONAL_MAKER_FEE_BPS` (default `0`) / `VARIATIONAL_TAKER_FEE_BPS` (default `0`) as config inputs to the open-trade routing rule; document that spread is captured in the quote, not in these bps.

## Endpoint behavior to preserve

- List-wrapped responses: `quotes/indicative`, `quotes/accept` may return `[{...}]` — always unwrap.
- Error bodies: check `error_message`, then `message`, then `raw`; HTTP ≥ 400 throws `ExchangeHttpError`-style.
- `/orders/v2` accepts **no query params** (older `status` param rejected).
- Numeric strings everywhere: strict `parseDecimal` with field names.
- Retries: only `/positions` gets 3× retry in the reference; network errors only.

## Implementation map

| File | Change |
| ------ | -------- |
| `packages/domain/src/index.ts` | add `'variational'` to `ExchangeId` |
| `packages/config/src/index.ts` | `variational` config block, fee bps vars, `parseExchange` whitelist |
| `apps/bot/src/exchanges/variational/variational-http-client.ts` | fetch wrapper + cookie jar + 401 re-login |
| `apps/bot/src/exchanges/variational/variational-auth.ts` | SIWE login session (@noble/curves signing, referral retry) |
| `apps/bot/src/exchanges/variational/variational.types.ts` | config + response shapes |
| `apps/bot/src/exchanges/variational/variational-client.ts` | `ExchangeAdapter` (markets, cached price snapshot, fail-closed) |
| `apps/bot/src/exchanges/variational/variational-execution-adapter.ts` | `ExecutionAdapter` per mapping table |
| `apps/bot/src/exchanges/registry.ts` | import + `['variational', ...]` entry |
| `apps/bot/src/main.ts` | guardrail warn block for `VARIATIONAL_TRADING_ENABLED` |
| `apps/bot/src/notifications/telegram-command-poller.ts` | fees map entry |
| `apps/bot/test/open-trade.test.ts`, `trade-summary.test.ts` | minimal fixture updates so `Record<ExchangeId,...>` typechecks (test expansion stays paused) |
| `apps/backend/src/config.ts`, `exchanges/balance-service.ts`, `exchanges/balance-normalizers.ts`, `server.ts` | variational balance read + `/api/exchanges/variational/balance` + `getAllBalances` |
| `apps/web/src/features/dashboard/Dashboard.tsx` | third balance card |
| `.env.example`, `docs/exchanges/README.md`, `specs/exchange-execution.md`, `AGENTS.md` | env vars, index entry, support matrix row, context refresh |

## Before live trading checklist

- [ ] Dry-run monitoring against mainnet prices for several days (cache TTL tuned, no 429s).
- [ ] `PRICE_SOURCE=mark` only; verify `index`/`last` fail closed with clear errors.
- [ ] Login flow verified: fresh-wallet referral path and existing-wallet retry-without-code path.
- [ ] 401 mid-session triggers re-login once, then surfaces error.
- [ ] Confirm no Cloudflare challenges on the server's IP (native fetch).
- [ ] TP intentionally blocked; SL (`stop_loss`) order verified with tiny reduce-only size before any real trade.
- [ ] Market (RFQ accept) hedge verified with minimal qty; `max_slippage` value reviewed.
- [ ] Passive-limit entry smoke test: observe behavior when limit price crosses (does the API reject, match, or rest?).
- [ ] Balance/margin reads reconcile with the frontend UI.
- [ ] `VARIATIONAL_TRADING_ENABLED=true` only after all of the above, with explicit user approval.
