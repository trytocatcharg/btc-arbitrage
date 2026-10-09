import type { BotConfig } from "@btc-arbitrage/config";
import type { getDb } from "@btc-arbitrage/db";
import { runDataRetention } from "./data-retention.js";

/**
 * Step 3 (trade-execution-queue): data retention scheduler.
 *
 * Data retention used to be invoked from every signal tick and rely on a
 * module-local 24 h throttle for cadence. It now runs on its own timer,
 * once per day at a fixed quiet hour, decoupled from the hot path. The
 * module-local throttle inside runDataRetention stays as belt-and-braces.
 *
 * No new env keys (operator decision 2026-10-07): the quiet hour is
 * hardcoded. The bot process typically runs on UTC inside Docker, where
 * 03:00 sits inside the quietest window for both American and European
 * operator timezones. On non-UTC hosts the run follows local time, which
 * is still a fixed daily hour.
 */
const RETENTION_QUIET_HOUR_LOCAL = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

type Db = Awaited<ReturnType<typeof getDb>>;

export interface RetentionScheduler {
  /** F3 shutdown contract: clears the pending timer so the Node event
   *  loop can drain and the process exits after SIGINT/SIGTERM or a
   *  /bot restart. An in-flight run is left to finish (bounded by the DB
   *  call timeouts), mirroring the monitor interval contract. */
  stop(): void;
}

export function startRetentionScheduler(input: {
  db: Db;
  config: BotConfig;
  isShuttingDown(): boolean;
}): RetentionScheduler {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  // F2 re-entrancy guard mirroring ExecutionQueue.draining and the
  // monitor interval: each pass chains its own next schedule, so overlap
  // is only possible if a run outlived a full day — refuse and skip.
  let runInFlight = false;

  function msUntilNextQuietHour(nowMs: number): number {
    const next = new Date(nowMs);
    next.setHours(RETENTION_QUIET_HOUR_LOCAL, 0, 0, 0);
    if (next.getTime() <= nowMs) next.setDate(next.getDate() + 1);
    return next.getTime() - nowMs;
  }

  function schedule(delayMs: number): void {
    if (stopped) return;
    timer = setTimeout(() => {
      void runScheduledPass();
    }, delayMs);
  }

  async function runScheduledPass(): Promise<void> {
    if (stopped || input.isShuttingDown()) return;
    if (runInFlight) {
      console.warn(
        "Data retention run skipped: previous run still in flight",
      );
      schedule(DAY_MS);
      return;
    }
    runInFlight = true;
    const startedAtMs = Date.now();
    console.log("Data retention run started", {
      startedAt: new Date(startedAtMs).toISOString(),
    });
    try {
      // Intentionally NOT gated on the bot-control pause flags: pruning
      // stale rows stays useful while paused, same semantics as when the
      // call lived in the tick (before the pause check).
      await runDataRetention(input.db, input.config);
      console.log("Data retention run completed", {
        durationMs: Date.now() - startedAtMs,
      });
    } catch (error) {
      console.error(
        "Data retention failed",
        error instanceof Error ? { message: error.message } : { error },
      );
    } finally {
      runInFlight = false;
      // Chain the next run one day after this pass. A long prune can only
      // shift the quiet hour by its own duration (minutes at most); the
      // in-flight guard covers the pathological overlap.
      schedule(DAY_MS);
    }
  }

  schedule(msUntilNextQuietHour(Date.now()));

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
