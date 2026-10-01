# Feature: Arcus live trading (execution adapter)

Authorized: 2026-09 (user explicitly opted in: "Trading live (orders)" + "Account reads / balances" for Arcus).
Runtime gate stays `ARCUS_TRADING_ENABLED=false` by default — implementation only, no live enablement.

## Why

Arcus is currently market-data only (`capabilities.orderPlacement: false`, no execution
adapter). The operator wants Arcus as a fully tradable venue in the pair, same as
risex/extended: passive maker entry, immediate taker hedge, TP/SL reduce-only protection.

## Source-of-truth API facts (fetched 2026-09 from docs.arcus.xyz)

- Auth: Ed25519 API key (hex pubkey = `X-API-Key`), `X-Timestamp` = Unix **nanoseconds**
  (±30 s server skew), `X-Signature` = 128 hex chars.
- Scheme 1 (typed payload, signed = canonical JSON payload itself): `placeOrder` op=1,
  `cancelOrder` op=2, `modifyOrder` op=3, untriggered TPSL op=4. Keys sorted, no
  whitespace; `ad` lowercased; other strings verbatim; `c` omitted when empty.
- Integers in payload: `p` = price/tickSize, `q` = size/stepSize, `g` = goodTilTime in
  **ns** (request body uses **microseconds**), `ct` = client timestamp ns = X-Timestamp.
  Nanosecond values exceed `Number.MAX_SAFE_INTEGER` → canonical JSON must be
  BigInt-safe (custom serializer, not JSON.stringify).
- `goodTilTime` required on EVERY order (incl. FOK/IOC), must be ≥ 1 month in the future;
  engine cancels at expiry. → use ~90 days, env-tunable (`ARCUS_ORDER_EXPIRATION_DAYS`).
- TIF: `0` GTT, `1` FOK, `2` IOC, `3` ALO (post-only). Post-only reject =
  `POST_ONLY_WOULD_CROSS` (matches Extended retry semantics).
- Order types: LIMIT, MARKET (requires `price` as protective slippage bound within 10%
  of mark price; for TPSL within 10% of stopPrice). TP/SL: `tpslType` STOP_LOSS /
  TAKE_PROFIT + `stopPrice`, `reduceOnly: true` mandatory.
- Account reads are PUBLIC: `GET /v1/account?address=` → equity/freeCollateral;
  `GET /v1/positions?address=&market=BTC-USD` → positions keyed by marketId with
  `size` (signed), `averageEntryPrice`, `markPx`. `GET /v1/account` 404s until first
  deposit.
- Cancel: `POST /v1/cancelOrder?address=` signed op=2, by `id` or `c` (clientId).
- Order status: `GET /v1/orderStatus` with `address` + order id (see Task 1).
- `setLeverage`: POST, legacy Scheme 2 (`timestamp + action + canonicalJSON(body)`).
- Subaccounts: `accountIndex` 0–9, default 0 (`ARCUS_ACCOUNT_INDEX`).

## Design decisions

- Signing: `@noble/curves` ed25519 (already a dep). Secret = `ARCUS_PRIVATE_KEY`
  (32-byte seed hex) — redactSecrets covers `private|key`, never logged.
- `ArcusConfig` gains: `privateKey?`, `accountIndex`, `orderExpirationDays`,
  `makerFeeBps`/`takerFeeBps` (routing inputs, same pattern as risex/extended).
- Market metadata (tickSize/stepSize) from `GET /v1/markets` (Task 1 pins field names).
- TP/SL price bound: reuse the Extended pattern (trigger ∓ buffer bps, within 10%
  mark/stop tolerance).
- `resolveLegClosure` reconstructs exit from TP/SL order status (same pattern as
  Extended adapter).
- No unit tests (explicit user pause since 2026-08-16). Verification = `yarn typecheck`.

## Tasks

- [ ] 1. Pin down Arcus API schemas + update docs/exchanges/arcus.md spec
- [ ] 2. Add Arcus trading config + env vars
- [ ] 3. Implement Ed25519 signing module
- [ ] 4. Extend ArcusHttpClient with signed POST
- [ ] 5. Implement arcus-execution-adapter.ts
- [ ] 6. Wire execution into adapter/registry/startup
- [ ] 7. Typecheck + final docs verification

## Evidence

(commits appended per task)
