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

- `monitorTrades` (`apps/bot/src/trading/trade-monitor.ts`) only acts on
  trades in `activeTradeStatuses` with legs `open`/`unhedged`. In-flight
  executions sit in `executing_limit`/`hedging`/`protecting`; legs become
  `open` only after the entry fill, when the position already exists
  (so `positionClosed=false` and the monitor skips). No interleave hazard.
- `monitorTimeoutClosures` only acts on trades with status `"open"`.
  No interleave hazard.
- The queue MUST be serial (one job at a time, FIFO): two rapid `open:`
  taps must never overlap executions. Ordering is preserved.
- Crash behavior unchanged: a restart mid-execution orphans the same DB
  states as today; the stale-`closing` recovery sweep handles them.

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
      in the working tree (unstaged, not committed — the operator
      commits); verified: typecheck exit 0, execution-queue tests 5/5.**
- [ ] Step 2 — move `monitorTrades` + `monitorTimeoutClosures` to their
      own interval, decoupled from the signal tick.
- [ ] Step 3 — data retention off the hot path (daily scheduler at a
      quiet hour instead of inside every tick).
- [ ] Step 4 (optional) — process split: `bot-monitor` (signals +
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
