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

1. [x] Instrument trade-monitor: write trade_status_history rows inside the same
   transaction for the monitor-driven 'unhedged' and 'closed' transitions
   (fromStatus = status read at query time; reason = leg closeReason; metadata =
   closed-leg identity). — bot write path, no behavior change. — commit 046ac50
2. [x] Backend trades-analysis service + normalizers + routes:
   - GET /api/trades/unhedged/active
   - GET /api/trades/unhedged/events?limit=&sinceDays=
   - GET /api/trades/:id/timeline (404 contract)
   — commit 046ac50
3. [x] Update specs/backend.md (route list, section 4 semantics + PnL convention,
   non-goals reworded). — commit 046ac50
4. [x] yarn typecheck clean (exit 0, all 8 workspaces); work-unit commit
   046ac50 on feat/unhedged-observability.

## Non-goals (this feature)

- No exit-policy behavior changes (trailing stop etc.) — analysis comes next.
- No unrealized-PnL sampling during unhedged windows (needs bot tick
  instrumentation; separate feature).
- No unit tests (explicitly paused by operator instruction).
- No events-table usage.
- No web dashboard UI.

## Commits

- 046ac50 — feat(backend): unhedged-window observability APIs + monitor
  status-history instrumentation (tasks 1-4, typecheck exit 0)

## Next step

Unhedged-window unrealized-PnL sampling in the bot tick (separate feature) so
the analysis agent can measure intra-window drawdown, not just final outcomes.
