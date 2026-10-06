# Feature: Trade execution queue (decouple execution from the polling loop)

## Context

The bot runs everything in one sequential polling tick. Trade execution
(limit fill wait up to `OPEN_TRADE_LIMIT_TIMEOUT_MS`, hedge, TP/SL) is
executed inline inside the Telegram `open:` callback and inside the
signal tick (`autoConfirmSignalTrade`), freezing price polling, leg
monitoring, and Telegram handling for 30–45 s (worst case ~90 s).

Step 1 of the incremental decoupling refactor (agreed with the operator):
execute trades through a serial in-process queue so the polling loop never
blocks on trade execution. Later steps: move monitors to their own
intervals, daily retention scheduler, optional process split.

## Safety analysis (done before implementation)

- `monitorTrades` only acts on trades in `activeTradeStatuses` with legs
  `open`/`unhedged`. In-flight executions sit in
  `executing_limit`/`hedging`/`protecting`; legs become `open` only after
  the entry fill, when the position exists (so `positionClosed=false` and
  the monitor skips). No interleave hazard.
- `monitorTimeoutClosures` only acts on trades with status `"open"`.
  No interleave hazard.
- Queue is serial (one job at a time): two rapid `open:` taps cannot
  overlap executions; ordering is preserved.
- Crash behavior unchanged: a restart mid-execution orphans the same DB
  states as today; the stale-`closing` recovery sweep handles them.

## Tasks

- [x] 1. `ExecutionQueue` in `apps/bot/src/trading/execution-queue.ts`:
      serial drain, error isolation per job, `isExecuting()`, logging.
- [x] 2. Wire `open:` / `retrade:` callbacks in
      `telegram-command-poller.ts` to enqueue; keep preview creation and
      the "⏳ Opening trade…" edit inline (fast, synchronous feedback and
      stale-quote errors must still surface in the callback).
- [x] 3. Wire `autoConfirmSignalTrade` in `polling-loop.ts` to enqueue.
- [x] 4. Create the queue in `main.ts` and inject it.
- [x] 5. Tests: `apps/bot/test/execution-queue.test.ts` (non-blocking
      enqueue, serial order, error isolation, enqueue-during-drain,
      isExecuting). Tests re-enabled for this feature by explicit
      operator permission (2026-10-06).

## Evidence

- Branch: `feat/trade-execution-queue`
- Checks: `yarn typecheck`, `node --import tsx --test apps/bot/test/*.test.ts`
- Commit: _pending_
