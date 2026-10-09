# Plan (futuro): Trade execution queue — decouple execution from the polling loop

> **Status: NOT implemented.** This document is the implementation plan,
> refined from a fully-built-and-reverted first attempt (implemented and
> verified green on 2026-10-06, then reverted at the operator's request
> before pushing; commits `b6ee86b`/`8eef060`/`f909c7d` remain in local
> history as reference). When the operator green-lights it, implement
> exactly per this contract — it already passed independent review once.

## Context

The bot runs everything in one sequential polling tick
(`apps/bot/src/runtime/polling-loop.ts`). Trade execution runs INLINE
inside the Telegram `open:`/`retrade:` callbacks and the signal tick
(`autoConfirmSignalTrade`), freezing price polling, leg monitoring, and
Telegram handling for the whole window: limit fill wait up to
`OPEN_TRADE_LIMIT_TIMEOUT_MS` (30 s default, polled every 250 ms),
repricing every 2 s, then hedge + TP/SL network calls → 30–45 s typical,
~90 s worst case (10 s timeouts per call).

There was a real incident of this class: a hung Telegram request froze
the loop forever (patched 2026-09-28 with `TELEGRAM_REQUEST_TIMEOUT_MS`
in `telegram-command-poller.ts`). The sequential architecture that
allowed it is unchanged.

Step 1 of an incremental decoupling roadmap (steps 2–4 below). The
operator wants each step merged to master one at a time, verified in
between.

## Safety analysis (verified against code, 2026-10-06)

- `monitorTimeoutClosures` only acts on trades with status `"open"`.
  No interleave hazard.
- The queue MUST be serial (one job at a time, FIFO): two rapid `open:`
  taps must never overlap executions. Ordering is preserved.
- Crash behavior unchanged: a restart mid-execution orphans the same DB
  states as today; the stale-`closing` recovery sweep handles them.
- ~~`monitorTrades` ... legs become `open` only after the entry fill ...~~
  **CORRECTED 2026-10-07 (see re-review below): this bullet was WRONG
  for the hedge leg and must not be relied on.**

## Safety re-review (2026-10-07, parent + 2 independent read-only agents)

Three-way re-verification of the safety analysis against current code
(Step 1 implemented, queue detached). Findings:

### F1 (HIGH, already possible with Step 1) — false hedge-leg closure during `hedging`

The hedge leg row transitions to `open` DURING `hedging`
(`open-trade.ts` ~L723, inside the fill loop), while the maker limit is
still resting (up to 30 s). `monitorTrades` filters on
`trades.status ∈ activeTradeStatuses` (which INCLUDES `hedging`) with
legs `open`/`unhedged`, so that combination IS monitored. Extended
`getPosition` can briefly return `null` post-fill (read lag documented in
open-trade.ts) → `positionClosed=true` → the monitor marks the leg
`closed` and sets `closureNotifiedAt` IRREVERSIBLY in one pass (no
re-verification, no grace period). The execution job later overwrites
`trades.status` back to `open` via `transition()`, but the leg row stays
`closed`+notified → the leg is permanently unmonitored (a real TP/SL
fire afterwards is never detected, the trade never closes, and signal
suppression stays active indefinitely; time-stop is disabled).

#### F1 mitigation (prerequisite, not optional)

In `monitorTrades`, only
act on trades with status `"open"` — venue TP/SL only exist from
`protecting`/`open`, so no real closure is missed. Cheaper alternative or
additional belt: skip legs whose trade `openedAt` is very recent
(< 30–60 s). Multi-read confirmation (2–3 consecutive null reads across
passes) also possible but heavier.

### F2 (MED, new with Step 2) — monitor-interval re-entrancy

`setInterval` fires on wall-clock regardless of an in-flight pass;
monitor passes can exceed 1 s (10 s per-call exchange timeouts), and
`closeTradeBothLegs` can take ~90–110 s worst case vs the sweep's 120 s
stale budget. Nothing prevents overlapping passes today-in-proposal.
**Requirement:** in-flight guard mirroring `ExecutionQueue.draining`
(check-and-set synchronously at the top of the interval callback, reset
in `finally`, log skipped cadences).

### F3 (MED, new with Step 2) — shutdown contract

The shutdown flag is module-local to `polling-loop.ts`; the new interval
must: (a) check `isShuttingDown()` at the top of each pass, (b)
`clearInterval` before the loop function returns — otherwise the timer
keeps the Node event loop alive and the process NEVER exits after
SIGINT, (c) let an in-flight pass finish (bounded by existing timeouts).

### F4 — hot-spin `continue` is NOT fixed by the split alone

The suppression `continue` (`polling-loop.ts` ~L153) skips the tail
including the sleep; even with monitors moved out, the signal loop still
hot-spins on `pollOnce` + price fetch while a trade is active.
**Requirement:** restructure the suppression branch so every tick path
reaches the sleep (e.g. wrap the signal tail in `if (!suppressed)`
instead of `continue`).

### Confirmed safe (no action)

- Shared in-memory config (poller `/config` overrides) and
  `TelegramNotifier` cooldown state: monitors never read/write them;
  single-writer + JS atomicity holds with two intervals. Keep passing
  the SAME config object by reference.
- No execution-queue job ever sets `trades.status='closing'` (edge band
  disabled, retryEntry catch never claims 'closing') → the stale-closing
  recovery sweep and the queue operate on disjoint row sets.
- Signal suppression check-then-insert across intervals only shifts
  timing by one cadence; protected downstream (notifier cooldown,
  operator confirmation, next-tick suppression). No transaction needed.
- No new env keys: reuse `PRICE_POLL_INTERVAL_MS` for the monitor
  cadence (operator decision 2026-10-07: leave env keys untouched).

## Design contract

### 1. NEW `apps/bot/src/trading/execution-queue.ts`

```ts
export interface ExecutionJob {
  /** Short human-readable label for logs, e.g. "open-trade:<token-prefix>". */
  readonly description: string;
  run(): Promise<void>;
}

export class ExecutionQueue {
  enqueue(job: ExecutionJob): void;   // returns immediately, never awaits run()
  isExecuting(): boolean;             // true while a job's run() is in flight
}
```

- Serial guarantee: at most one job runs at a time; FIFO. A job enqueued
  from inside a running job is consumed by the same drain pass.
- Error isolation: a throwing job must not stop the drain;
  `console.error("Execution job failed", { description, durationMs, message })`,
  continue with the next job, never rethrow to the enqueuer.
- Log enqueue (`{ description, pending }`), job start, completion with
  `durationMs`.
- Detached execution: `enqueue` kicks the drain via a floating promise
  (`void this.drain()`); internal `draining` flag prevents concurrent
  drains. No unhandled-rejection path (per-job try/catch inside the loop).

### 2. EDIT `apps/bot/src/notifications/telegram-command-poller.ts`

- Constructor gains a required 5th parameter `executionQueue:
  ExecutionQueue` (after `fetchImpl`). Update any test call sites.
- `open:` branch — KEEP awaited inline (unchanged): signal row load,
  `createPreview`, the `editMessageText` "⏳ Opening trade…" feedback.
  Synchronous preview-creation errors must still propagate to the
  existing callback catch (friendly toast). Then enqueue ONE job whose
  `run()` does `confirm(preview.token)` + `reportTradeOutcome(...)`.
  Job catch: log AND edit the trigger message with the same
  `❌ Trade failed: <message>` text the old inline catch produced.
- `retrade:` branch — keep row load + status check inline; enqueue
  `retryEntry(preview)` + its outcome messaging (opened → fill summary,
  edge_closed → notice, cancelled → nothing, else → undefined-result
  warning). Job catch must ALSO notify the operator (`❌ Retry failed: …`
  via `sendMessage`) — the first attempt missed this and was caught in
  review; parity with the old callback-catch feedback is required.
- `pollOnce()` must return without waiting for queued execution;
  trailing `answerCallback` stays awaited.

### 3. EDIT `apps/bot/src/runtime/polling-loop.ts`

- `runPollingLoop` input gains required `executionQueue: ExecutionQueue`.
- `autoConfirm` branch: replace `await autoConfirmSignalTrade({...})`
  with `executionQueue.enqueue({ description, run: () => autoConfirmSignalTrade({...}) })`.
  Errors handled only by the queue's per-job catch.

### 4. EDIT `apps/bot/src/main.ts`

- One `const executionQueue = new ExecutionQueue()` shared by
  `runPollingLoop` and `TelegramCommandPoller`.

### 5. NEW `apps/bot/test/execution-queue.test.ts`

node:test + node:assert/strict, in-memory, deferred promises (no fake
timer libs). Five tests:

1. enqueue returns before the job completes.
2. Serial FIFO order: job2 does not start while job1 is blocked; runs
   after job1 finishes.
3. Error isolation: throwing job is logged (spy `console.error`),
   subsequent job still runs.
4. Enqueue-during-drain: job enqueued from inside job1 runs in the same
   pass, after job1.
5. `isExecuting()` true in flight, false after.

## Verification (per step, before merging to master)

1. `yarn typecheck`
2. `node --import tsx --test apps/bot/test/execution-queue.test.ts`
3. `node --import tsx --test apps/bot/test/*.test.ts` — known pre-existing
   drift, expected and NOT caused by this change (confirmed byte-identical
   on master 2026-10-06): `open-trade.test.ts` 5/7 (margin-based TP/SL
   drift), `trade-summary.test.ts` 1 wording failure,
   `risex-execution-adapter.test.ts` hangs (market-fill poll spins).

## Roadmap (this doc is step 1 of 4)

- [x] Step 1 — this queue (decouple execution). **Implemented 2026-10-07**
      and committed by the operator as `b38c1a2` "decoupling fix";
      verified at implementation time: typecheck exit 0, execution-queue
      tests 5/5.**
- [x] Step 2 — move `monitorTrades` + `monitorTimeoutClosures` to their
      own interval, decoupled from the signal tick. PREREQUISITES from
      the 2026-10-07 re-review: F1 mitigation in `monitorTrades`
      (act only on `trades.status === "open"`), F2 re-entrancy guard,
      F3 shutdown contract (clearInterval + isShuttingDown), F4 hot-spin
      restructure (every tick path reaches the sleep). Reuse
      `PRICE_POLL_INTERVAL_MS`; no env key changes.
      **Implemented 2026-10-07 and committed by the operator as `0521f25`
      "refactor pooling interval strategy" (monitor interval +
      `close-recovery-monitor.ts`, `timeout-close-monitor.ts` deleted,
      F1–F4 all landed); verified at implementation time: typecheck
      clean, all non-drift bot tests green, drift unchanged.**
- [x] Step 3 — data retention off the hot path (daily scheduler at a
      quiet hour instead of inside every tick). **Implemented 2026-10-08
      in the working tree (unstaged, not committed — the operator
      commits): NEW
      `apps/bot/src/retention/retention-scheduler.ts` (one run per day
      at 03:00 local server time, hardcoded — no new env keys; F2
      in-flight guard; F3 `stop()` shutdown contract); polling-loop no
      longer invokes retention per tick, except the single inline pass
      kept for `BOT_RUN_ONCE` mode (no timer lifetime there); the
      scheduler is started next to the monitor interval and stopped on
      loop exit; pruning intentionally keeps running while paused, same
      semantics as before; the module-local 24 h throttle inside
      `runDataRetention` stays as belt-and-braces.**
- [x] Step 4 — Telegram command polling on its own interval instead of
      inside the signal tick (alternative A of the 2026-10-08 review:
      single operator, low command volume). Same contracts as the monitor
      interval: cadence reuses `PRICE_POLL_INTERVAL_MS`, no new env keys,
      F2 re-entrancy guard (skip logged once, not per second), F3
      `clearInterval` on loop exit. Deliberately NOT gated on the pause
      flags (operator keeps full control of a paused bot) and not gated
      on restart until exit, mirroring the monitor interval. `BOT_RUN_ONCE`
      keeps the single inline poll (no timer lifetime). Outbound
      notifications were already fire-and-forget and are unchanged.
      **Implemented 2026-10-08 in the working tree (unstaged, not
      committed — the operator commits).**
- [ ] Step 5 (optional) — process split: `bot-monitor` (signals +
      Telegram + monitors) and `bot-executor` (queue consumer) against
      the same DB, only if crash isolation is needed.

## Notes for the implementer

- The revert commit `f909c7d` reverses the original implementation
  exactly; `git show b6ee86b` shows the full original diff if useful as
  a starting point (do not cherry-pick blindly — the `retrade:` error
  feedback fix landed after that commit).
- The runtime-settings mutations in the poller (`applyCooldownMinutes`
  etc.) share the in-memory `config` object; an in-process queue keeps
  that working. A future process split (step 4) will need config
  propagation through the DB.
- Known quirk that step 2 resolves for free: signal suppression uses
  `continue`, skipping the tick sleep (hot spin while a trade is active).
