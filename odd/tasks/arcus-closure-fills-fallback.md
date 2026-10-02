# Feature: Arcus closure fills fallback

## Context

When an Arcus leg closes without the bot's stored TP/SL firing (operator
moves/replaces a trigger on the venue, or closes the position manually),
the position disappears from `GET /v1/positions` and the stored
`tpOrderId`/`slOrderId` resolve nothing. The monitor then records
`exit_price = NULL`, `close_reason = 'unknown'`, skips the farmed-volume
increment, and Telegram shows `n/a` (observed live 2026-10-02, trade #313,
leg 616).

Arcus exposes `GET /v1/fills` (public, `?address=` only): newest-first
fill history with `price`, `fee`, `closedPnl`, `positionEffect`
(`OPEN_LONG` / `CLOSE_SHORT`, ...), `createdAt` (epoch µs), `side`,
`orderId`, `liquidation`. Source: https://docs.arcus.xyz/api-reference/public/get-fills

## Goal

Before notifying, when closure resolution comes back empty, resolve the
exit from the fill history: price (VWAP over the close fills), real fee,
realized PnL, close reason (`manual` / `liquidation`), exit order id.

## Tasks

- [x] T1 Contract + monitor wiring: add optional `quantityBase` to
  `resolveLegClosure` input in `packages/exchange-core/src/index.ts`;
  pass `row.trade_legs.quantityBase` from `apps/bot/src/trading/trade-monitor.ts`;
  relax the monitor condition so resolution is attempted whenever exit
  data is missing and the adapter implements the method (no longer
  requires stored protection ids — Extended/RISEx tolerate absent ids).
- [x] T2 Arcus fills fallback in
  `apps/bot/src/exchanges/arcus/arcus-execution-adapter.ts`
  `resolveLegClosure`: only when the stored-id loop finds nothing fired;
  `GET /v1/fills?address=&market=&from=` (24 h lookback, epoch µs);
  match `positionEffect` CLOSE_<side> (fallback to side BUY/SELL mapping);
  walk newest-first accumulating fills until cumulative size reaches
  `quantityBase` (VWAP price, summed fee + closedPnl); without
  `quantityBase` take the newest matching fill only; `closeReason` =
  `liquidation` when any fill carries `liquidation`, else `manual`;
  never throw — degrade to `null` so the current n/a behavior remains the
  floor.
- [x] T3 Docs: add the `GET /v1/fills` row to `docs/exchanges/arcus.md`
  (endpoint table + execution-facts note that fills carry a per-fill fee,
  unlike `/v1/order/{orderId}`); amend the `resolveLegClosure` docstring
  in exchange-core to cover history-based recovery.
- [x] T4 Checks: `yarn typecheck` green. No new unit tests (paused by
  explicit user instruction 2026-08-16).

## Out of scope

- DB backfill for the already-lost legs (separate, manual SQL — see
  session discussion; legs 426/440/496/602/612 missing ENTRY volume is a
  different bug in the open path, not this feature).
- The same fallback in `trade-close.ts` (bot-initiated spread close path)
  — follow-up if wanted.
- WebSocket fills subscription (documented Arcus future work).

## Evidence

- Branch: feat/arcus-closure-fills-fallback
- Typecheck: green (`yarn typecheck`, exit 0, verified by parent)
- Work-unit commit: pending (this file is committed with it)
- Implementation delegated to gentle-ai-worker; deviations accepted:
  fallback lives in a private `resolveClosureFromFills` invoked from the
  outer try of `resolveLegClosure`; exact-decimal helpers via scaled
  BigInt at module bottom.
