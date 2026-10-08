import { desc, inArray } from "drizzle-orm";
import { activeTradeStatuses, trades } from "@btc-arbitrage/db";
import type { getDb } from "@btc-arbitrage/db";

/**
 * Pause/resume/restart control for the monitoring loop. The control starts
 * unpaused; pause() makes the polling loop skip work, resume() and
 * requestRestart() wake any sleep early so the loop reacts promptly.
 */
export interface BotControl {
  isPaused(): boolean;
  pause(): void;
  resume(): void;
  isRestartRequested(): boolean;
  requestRestart(): void;
  /** sleep that resolves early on resume/restart */
  waitOrSleep(ms: number): Promise<void>;
}

/** In-memory, dependency-free pause/resume/restart control. */
export function createBotControl(): BotControl {
  let paused = false;
  let restartRequested = false;
  let wakeResolver: (() => void) | null = null;

  function wake(): void {
    const resolve = wakeResolver;
    wakeResolver = null;
    resolve?.();
  }

  return {
    isPaused(): boolean {
      return paused;
    },
    pause(): void {
      paused = true;
    },
    resume(): void {
      paused = false;
      wake();
    },
    isRestartRequested(): boolean {
      return restartRequested;
    },
    requestRestart(): void {
      restartRequested = true;
      wake();
    },
    waitOrSleep(ms: number): Promise<void> {
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wakeResolver = null;
          resolve();
        }, ms);
        wakeResolver = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    },
  };
}

/** Lightweight reference to a trade that is still active. */
export interface ActiveTradeRef {
  id: number;
  status: string;
}

/** Active trades, newest first; used by control surfaces to block pause/safe actions. */
export async function loadActiveTrades(
  db: Awaited<ReturnType<typeof getDb>>,
): Promise<ActiveTradeRef[]> {
  return db
    .select({ id: trades.id, status: trades.status })
    .from(trades)
    .where(inArray(trades.status, [...activeTradeStatuses]))
    .orderBy(desc(trades.id));
}
