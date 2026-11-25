# Closure resolution retry + id-less fallback (risex)

Origin: trade #1370 (2026-11-24). Operator moved the risex SL manually on the
exchange UI → risex cancelled the bot-placed TP/SL (`user_cancelled`) and the
operator's new SL fired under a different order id. `resolveLegClosure` only
matched the stored tp/sl ids → null on all retries → leg 2730 persisted with
`exit_price_usd NULL`, `close_reason 'unknown'` → Telegram "PnL n/a".

Operator guarantees: never more than 1 trade at a time (1 position per
market), so side+size+time attribution is safe.

## Decisions (operator-approved 2026-11-24)

- Automatic fallback runs on the FIRST monitor pass (no button tap needed),
  AND a manual `🔄 Reintentar resolución` button is attached whenever a
  closure message carries n/a values (escape hatch for anything weirder).
- Fallback scope: risex adapter only. Extended keeps its current id-based
  resolver (same gap exists there; follow-up if it ever bites).
- Retry re-resolves only closed legs with NULL exit data; it is an
  idempotent backfill — never touches `closureNotifiedAt` or trade status
  transitions.
- Corrected summary is sent as a NEW Telegram message (auditable), not an
  edit of the original.
- Unit tests remain paused (operator instruction 2026-08-16): no new tests;
  verification = `yarn typecheck` + code review.

## Tasks

- [ ] T1 — risex `resolveLegClosure` fallback levels:
  - L2: when no stored tp/sl id matches a SUCCESS trigger, scan the same
    `/v1/orders/tpsl` payload for ANY `TPSL_ORDER_STATUS_SUCCESS` trigger
    with closing side (short leg → BUY, long leg → SELL), size ≈
    `quantityBase`, `triggered_at >= created_at` of the stored protection
    records when those are present in the payload (risex-clock vs
    risex-clock only). Multiple candidates → most recent + loud log.
  - L3: when no SUCCESS trigger exists at all (manual market close), scan
    `/v1/orders` for a reduce-only FILLED order with matching side/size
    created after the protection anchor → `close_reason 'manual'`.
  - Downstream (closing-order VWAP, trade-history PnL/fees) is shared with
    the existing path. Loud logs when a fallback level is used.
- [ ] T2 — retry button end to end:
  - `monitorTrades` attaches `closureretry:<tradeId>` inline keyboard when
    the closed leg (or its closed sibling) has NULL exit price / PnL.
  - `notify` plumbing in trade-monitor + polling-loop gains an optional
    keyboard param (`notifyUrgent` already supports it).
  - New `trading/closure-retry.ts` service: re-resolve NULL-exit closed
    legs via the leg's adapter `resolveLegClosure`, update only NULL leg
    fields (+ `close_reason` when `'unknown'`), recompute
    `trades.realized_pnl_usd` (gross convention via `deriveLegGrossPnlUsd`)
    and `total_fees_usd` when the trade is closed, send corrected summary.
  - Poller: `closureretry:` callback → serial execution queue (same queue
    as `tradeclose:`), chat/user guard already global.
- [ ] T3 — verification: `yarn typecheck` (repo lint), focused review of
  the diff.
- [ ] T4 — DB correction for trade #1370 leg 2730 (operator-approved):
  exit 59557.6, exchange-reported realized +1.6648458464 (stored as-is per
  fee convention), exit fee 0.0497901536, close_reason 'sl', recompute
  trade totals. Done directly (no code), with before/after evidence.

## Evidence

- T1: <commit>
- T2: <commit>
- T3: typecheck output
- T4: before/after rows
