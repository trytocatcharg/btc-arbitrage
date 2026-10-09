# Feature: Unhedged observability (backend read-only APIs + bot history instrumentation)

## Context

Goal: give the offline strategy-improvement agent (and the operator) the data to
answer "how much money do we lose while a trade is unhedged?" — the first step of
the self-improving exit-policy loop (trailing stop / breakeven / hedge-on-retrace
analysis comes later, driven by this data).

Product decision (operator, this session): start with observability. No exit-policy
behavior changes in this feature.

## Evidence base (explored this session)

- Backend today exposes only balances + `GET /api/trades/volume-stats`
  (apps/backend/src/server.ts). Pattern: service module + normalizer + route,
  all read-only over the bot DB (see exchanges/volume-stats-service.ts).
- `trade_status_history` is written ONLY by DbPreviewStore.transition
  (apps/bot/src/trading/db-preview-store.ts:262). Verified by grep.
- apps/bot/src/trading/trade-monitor.ts flips trades to 'unhedged' (line ~220)
  and 'closed' (line ~202) with a raw `tx.update(trades)` inside its transaction
  — no history rows. Today an unhedged window is NOT reconstructible from the DB.
- close-recovery-monitor.ts status changes go through DbPreviewStore.transition
  (verified) — no instrumentation needed there.
- The `events` table has zero writers/readers in the codebase (dead schema) —
  excluded from the timeline endpoint v1.
- Backend was not responding on 127.0.0.1:3002 locally during exploration;
  live verification happens on the operator's deployed backend after rebuild.

## Tasks

1. [ ] Instrument trade-monitor: write trade_status_history rows inside the same
   transaction for the monitor-driven 'unhedged' and 'closed' transitions
   (fromStatus = status read at query time; reason = leg closeReason; metadata =
   closed-leg identity). — bot write path, no behavior change.
2. [ ] Backend trades-analysis service + normalizers + routes:
   - GET /api/trades/unhedged/active — trades currently unhedged: open leg
     (entry/qty/openedAt) + closed leg (closeReason/exit/realized/fees) +
     unhedgedSince (history-derived; fallback closed-leg closedAt or
     trades.updatedAt, flagged approximate).
   - GET /api/trades/unhedged/events?limit=&sinceDays= — historical windows:
     history rows toStatus='unhedged' (window start) → next transition to
     closed/failed (window end); durationMs; resolution open|closed|failed;
     both legs' outcomes; trade realizedPnlUsd/totalFeesUsd/netPnlUsd when
     resolved. Pre-instrumentation active unhedged trades merge in with
     approximateStart.
   - GET /api/trades/:id/timeline — trade + legs + statusHistory asc + signal.
   Conventions: read-only, decimals as strings, dates as ISO strings (match
   volume-stats normalizer), no new dependencies, no axios.
3. [ ] Update specs/backend.md: route list, semantics, derivation + caveats,
   reword "does not expose historical trade APIs yet" (paginated all-trades
   listing stays a non-goal).
4. [ ] yarn typecheck clean; work-unit commit(s) on feat/unhedged-observability.

## Non-goals (this feature)

- No exit-policy behavior changes (trailing stop etc.) — analysis comes next.
- No unrealized-PnL sampling during unhedged windows (needs bot tick
  instrumentation; separate feature).
- No unit tests (explicitly paused by operator instruction).
- No events-table usage.
- No web dashboard UI.

## Commits

(pending)
