# Feature: Leg closure exit price / PnL recovery

**Branch:** `fix/leg-closure-exit-price`
**Status:** in progress

## Problem (verified against production, trade #113, 2026-09-29)

When a leg is closed venue-side by a TP/SL trigger, `monitorTrades` detects the
flat position via `ExecutionAdapter.getPosition()`. RISEx
`GET /v1/account/position` never reports close data once flat (record removed /
no `close_price`/`realized_pnl` fields), and Extended `getPosition` returns
`null` when flat. Result: the Telegram notice reports exit price `n/a` and PnL
`n/a`, `close_reason` stays `unknown`, and the leg row keeps NULLs. When the
sibling leg later closes, the trade-level total PnL silently counts the leg as 0.

Real data verified live for trade #113 (RISEx SHORT leg, closed by SL):
- SL trigger `2d31cbe3…`: `/v1/orders/tpsl` → `status: TPSL_ORDER_STATUS_SUCCESS`,
  `triggered_at` (unix s), `triggered_price: 84163.357…` (mark).
- Closing fill: `/v1/orders` history → reduce-only LIMIT BUY, `avg_price: 84159.2`,
  `filled_size: 0.00417`, `created_at` (unix micros) ≈ `triggered_at`.
- `/v1/trade-history` fill → `realized_pnl: -1.66164375637248755` (net, string),
  `fee`, `price`, `size`. Sum across the order's fills.
- Extended TP/SL orders are queryable by id: `GET /api/v1/user/orders/{id}` →
  `type: TPSL`, `status: UNTRIGGERED`, `takeProfit`/`stopLoss` sub-objects with
  `status`, `triggerPrice`, `price`; top-level `averagePrice`, `filledQty`, `qty`.

Stored protection order ids already exist per leg in `trade_legs.raw`
(`tpOrderId`, `slOrderId`, `tpTriggerUsd`, `slTriggerUsd`) — the resolver keys
off these; no schema change needed.

## Tasks

- [x] 1. Contract: add optional `resolveLegClosure` to `ExecutionAdapter`
      (`packages/exchange-core/src/index.ts`) — input `{symbol, side,
      tpOrderId?, slOrderId?}`; output `{exitPriceUsd?, realizedPnlUsd?,
      exitOrderId?, closeReason?} | null`.
- [x] 2. RISEx adapter: implement `resolveLegClosure` (tpsl history → fired
      trigger → `/v1/orders` avg_price → `/v1/trade-history` realized_pnl sum).
- [x] 3. Extended adapter: implement `resolveLegClosure` via order-by-id lookup
      on the two known protection ids.
- [x] 4. Monitor: merge resolved closure data (exit price, PnL, closeReason,
      exitOrderId) into leg updates + Telegram message; reorder volumeDelta
      computation after merge; degrade gracefully on resolver failure.
- [x] 5. Checks: `yarn typecheck` green; existing bot tests green (no new tests
      — unit-test work paused by user instruction); update
      `docs/exchanges/risex-integration.md` known-limitation note.
      (Pre-existing base failures, reproduced on HEAD before the change:
      open-trade ×2 TP/SL anchor assertions, trade-summary ×2, and
      risex-execution-adapter.test.ts hang in the market-fill poll loop.)
- [x] 6. Work-unit commit on this branch: `26af193`
      `fix(bot): report exit price and PnL on venue-side TP/SL leg closures`.
- [x] 7. Backfill trade #113 RISEx leg 216 — **declined by user** (2026-09-29);
      the row keeps its NULLs/'unknown' and the fix covers future closures.

## Evidence

- Commit `26af193` on `fix/leg-closure-exit-price` (2026-09-29): 6 files,
  +463/−12. `yarn typecheck` green; bot suites pass except pre-existing
  failures reproduced identically on the base commit.
