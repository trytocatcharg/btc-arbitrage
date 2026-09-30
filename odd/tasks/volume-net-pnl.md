# Feature: /volume net PnL summary (net of real trading fees)

## Context

The `/volume` Telegram command (apps/bot/src/notifications/telegram-command-poller.ts,
`buildVolumeMessage`) reports farmed volume per view (total, previous month, 6 months),
attributed by trade `createdAt` month.

The user asked for a net-PnL summary in the same views. Product decisions (2026-10-01):

- **Net = realized PnL − real trading fees (entry + exit).**
- **Funding fees are OUT of scope for this cut** — no exchange payload we read today
  exposes funding; the label must say "sin funding" explicitly.
- Realized PnL caveats stay as-is: exchange-reported when available (RISEx position
  PnL), else locally computed gross `(exit − entry) × qty × side`. We subtract real
  fees on top; when a fee is unknown (null) it is simply not subtracted and the
  label says "fees conocidos".
- Fee columns exist in the schema but are dead today: `trade_legs.entry_fee_usd`,
  `exit_fee_usd`, `funding_fee_usd`, `trades.total_fees_usd`.

## Evidence base (explored 2026-10-01)

- `packages/exchange-core/src/index.ts` — `ExecutionOrder`, `ExchangePosition`, and
  `resolveLegClosure` result carry NO fee fields today.
- RISEx: `GET /v1/trade-history` per-fill records include `fee` (documented in
  `docs/exchanges/risex-integration.md`); the adapter already queries this endpoint
  for VWAP (risex-execution-adapter.ts ~L880-925) and in `resolveLegClosure`.
- Extended: fee schedule via `GET /api/v1/user/fees`; per-order fee field in the
  order payload is plausible but unverified — capture best-effort from candidate
  fields (`fee`, `totalFee`, `feeAmount`, `execFee`) and stay null when absent.
- Writers for fees do not exist anywhere in apps/bot (verified by grep).

## Tasks

1. [x] Extend execution contracts with optional `feeUsd` on `ExecutionOrder`,
   `ExchangePosition`, and the `resolveLegClosure` result
   (packages/exchange-core/src/index.ts). — commit 2838399
2. [x] RISEx adapter: sum per-fill `fee` from `/v1/trade-history` alongside the
   existing VWAP read (entry fills) and in `resolveLegClosure` (exit fills).
   — commit 2838399
3. [x] Extended adapter: best-effort `feeUsd` from order payload candidate fields
   in `mapExecutionOrder` and any closure-resolution path. — commit 2838399
4. [x] Persist leg fees: write `trade_legs.entry_fee_usd` on entry/hedge fills
   (open-trade flow) and `exit_fee_usd` on closes (trade-close.ts + trade-monitor
   TP/SL path); update `trades.total_fees_usd` at trade close (sum of known leg fees).
   — commit 2838399
5. [x] volume-stats.ts: `loadNetPnlTotals(db, range?)` (realized, known fees, net)
   with the same `createdAt` attribution; monthly net breakdown for the 6m view.
   — commit 92a0587
6. [x] /volume render: add net-PnL lines to all three views with label
   "neto de trading fees conocidos (sin funding)". — commit 92a0587
7. [x] Checks: bot + exchange-core typecheck green; work units committed.

## Non-goals

- Funding fee capture (no upstream source identified; column stays dead).
- Backfilling historical fees for already-closed trades.
- Test expansion (unit-test work paused by user instruction 2026-08-16).
- `unrealizedPnlUsd` in the summary (only closed/realized PnL).

## Decisions log

- 2026-10-01: net-with-fees chosen over realized-only; trading-fees-now chosen over
  funding research first.
- 2026-10-01: SQL over trade_legs is the source of truth for /volume net; the trade
  total_fees_usd is maintained at close for future display use.

Branch: feat/volume-net-pnl

Commits: f99a075 (variational http client, prior task) · 2838399 (fee capture +
persistence) · 92a0587 (net PnL aggregates + /volume render). Bot and
exchange-core typecheck green; tests not run (paused by user instruction).
