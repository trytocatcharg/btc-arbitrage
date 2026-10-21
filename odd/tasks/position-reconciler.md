# Feature — Position reconciler (P0)

**Motivation**: 2026-10-21 incident — a naked position existed on Extended (no DB leg, no TP/SL). The bot discovered it only when a new entry was rejected with HTTP 400 code 1140 (order cost 179.84 > available 39.17, signal 43354 / trade #1250). There is no reconciliation between exchange positions and DB legs: nothing on boot, nothing periodic.

**Goal**: a reconciler that, on boot and periodically, compares `getPosition` per execution-capable exchange against active DB legs. On untracked position: urgent alert (once per episode), block new trade entries (fail closed), unblock + notify when resolved.

**Non-goals**: auto-closing the naked position (operator decision); the liveness check of TP/SL orders (separate follow-up); reconciling the reverse direction (leg without position — the trade monitor already handles leg-closure detection).

## Tasks

1. [x] Config: `POSITION_RECONCILE_INTERVAL_MS` (default 60000, 0 disables) in `packages/config/src/index.ts` + `.env.example`.
2. [x] Module `apps/bot/src/trading/position-reconciler.ts`: detection, module-level block state, alert dedupe (detected/resolved episodes).
3. [x] Wire into the monitor pass in `apps/bot/src/runtime/polling-loop.ts` (own try/catch, rate-limited by interval).
4. [x] Entry guard in `OpenTradeService.confirm` (`apps/bot/src/trading/open-trade.ts`), next to the `hasBlockingExecution` check.
5. [x] Typecheck + docs (AGENTS.md env table) + work-unit commit on feature branch.

## Design notes (agreed with operator)

- Detection: for each adapter with `execution`, `getPosition({symbol, marketType, priceSource})`. Position qty > epsilon (1e-6) while sum of that exchange's active-leg qty (statuses `executing_limit|hedging|protecting|open|closing|unhedged`) + epsilon < position qty → untracked excess → block.
  - No active legs on that exchange + position > epsilon → naked (same block path).
  - Position smaller than leg sum → log only (monitor owns leg-closure detection).
- Block state: module-level in the reconciler (single bot process). Cleared automatically on the pass that sees the position gone; "resolved" alert on that transition.
- Guard: `confirm()` throws with a clear message before consuming anything heavy (place right after the `hasBlockingExecution` check, before `startExecution`).
- Alert: `notifier.notifyUrgent`, once per episode (not per pass).
- Interval check lives inside the reconciler run (pass passes `now`), same pattern as `sampleUnhedgedLegs`.
- Unit tests stay paused (operator instruction 2026-08-16); verification is `yarn typecheck`.

## Evidence

- Commit: `05c9dae` on `feature/position-reconciler` (6 files, +339)
- Typecheck: clean (exit 0)
- Deviations landed: (1) `getPosition` real signature is `{symbol, side}` — detection is per (exchange, side); (2) registry has no list method — walks `exchangeA`/`exchangeB`; (3) leg sum joins legs to trades in `activeTradeStatuses`, excluding terminal leg states; (4) `.env.example` addition BLOCKED by host Gentle AI safety policy (parent included) — pending operator decision; AGENTS.md row documents the var meanwhile.
