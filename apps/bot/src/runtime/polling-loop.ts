import { calculateSpread } from "@btc-arbitrage/domain";
import { sleep } from "@btc-arbitrage/shared";
import type { BotConfig } from "@btc-arbitrage/config";
import type { ExchangeAdapter } from "@btc-arbitrage/exchange-core";
import { SignalEngine } from "../signals/signal-engine.js";
import type { Notifier } from "../notifications/notifier.js";
import type { getDb } from "@btc-arbitrage/db";
import { signals, activeTradeStatuses, trades } from "@btc-arbitrage/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { monitorTrades } from "../trading/trade-monitor.js";
import { recoverStaleClosingTrades } from "../trading/close-recovery-monitor.js";
import { runDataRetention } from "../retention/data-retention.js";
import { shouldSuppressSignalForActiveTrades } from "../trading/trade-guards.js";
import type { ExecutionQueue } from "../trading/execution-queue.js";
import { autoConfirmSignalTrade } from "../trading/open-trade-factory.js";
import { extractInsertId } from "../db-result.js";

export interface ExchangeRegistry {
  get(id: string): ExchangeAdapter;
}

export interface CommandPoller {
  pollOnce(): Promise<void>;
}

export async function runPollingLoop(input: {
  config: BotConfig;
  registry: ExchangeRegistry;
  notifier: Notifier;
  db: Awaited<ReturnType<typeof getDb>>;
  commandPoller?: CommandPoller;
  executionQueue: ExecutionQueue;
}): Promise<void> {
  const exchangeA = input.registry.get(input.config.exchangeA);
  const exchangeB = input.registry.get(input.config.exchangeB);
  let tick = 0;

  console.log("Monitoring loop ready", {
    exchangeA: input.config.exchangeA,
    exchangeB: input.config.exchangeB,
    symbol: input.config.btcSymbol,
    marketType: input.config.marketType,
    priceSource: input.config.priceSource,
    pollIntervalMs: input.config.pricePollIntervalMs,
    minPriceDiffUsd: input.config.minPriceDiffUsd,
  });

  // Step 2 (trade-execution-queue): the trade monitors run on their own
  // wall-clock interval instead of inside the signal tick, so a slow
  // monitor pass can no longer delay price polling and signal evaluation.
  // The cadence reuses the already-loaded PRICE_POLL_INTERVAL_MS config
  // value — no new env keys. The SAME config object is passed by
  // reference everywhere, so the poller's /config runtime overrides keep
  // applying to both loops.
  let pass = 0;
  let monitorPassInFlight = false;
  const monitorTimer = setInterval(() => {
    // F3: never start a new pass once shutdown was requested; the timer
    // itself is cleared after the signal loop exits.
    if (isShuttingDown()) return;
    // F2: re-entrancy guard mirroring ExecutionQueue.draining — check and
    // set synchronously so an interval tick can never overlap an
    // in-flight pass; reset in the finally of runMonitorPass().
    if (monitorPassInFlight) {
      console.warn("Monitor pass skipped: previous pass still in flight", {
        pass,
      });
      return;
    }
    monitorPassInFlight = true;
    // Floating promise guarded by the in-flight flag and by the catches
    // inside runMonitorPass, so there is no unhandled-rejection path.
    void runMonitorPass();
  }, input.config.pricePollIntervalMs);

  async function runMonitorPass(): Promise<void> {
    pass += 1;
    const passStartedAt = new Date();
    console.log("Monitor pass started", {
      pass,
      startedAt: passStartedAt.toISOString(),
    });
    try {
      try {
        await monitorTrades({
          db: input.db,
          registry: input.registry,
          notify: (text) => input.notifier.notifyUrgent(text),
        });
      } catch (error) {
        console.error(
          "Trade monitoring failed",
          error instanceof Error
            ? { pass, message: error.message }
            : { pass, error },
        );
      }
      try {
        await recoverStaleClosingTrades({
          db: input.db,
          registry: input.registry,
          notifier: input.notifier,
        });
      } catch (error) {
        console.error(
          "Stale-close recovery failed",
          error instanceof Error
            ? { pass, message: error.message }
            : { pass, error },
        );
      }
      console.log("Monitor pass completed", {
        pass,
        durationMs: Date.now() - passStartedAt.getTime(),
      });
    } catch (error) {
      console.error(
        "Monitor pass failed",
        error instanceof Error
          ? { pass, message: error.message }
          : { pass, error },
      );
    } finally {
      monitorPassInFlight = false;
    }
  }

  while (!isShuttingDown()) {
    tick += 1;
    const tickStartedAt = new Date();
    console.log("Monitoring tick started", {
      tick,
      startedAt: tickStartedAt.toISOString(),
    });

    try {
      try {
        await input.commandPoller?.pollOnce();
      } catch (error) {
        console.error(
          "Telegram command polling failed",
          error instanceof Error
            ? { tick, message: error.message }
            : { tick, error },
        );
      }
      try {
        await runDataRetention(input.db, input.config);
      } catch (error) {
        console.error(
          "Data retention failed",
          error instanceof Error
            ? { tick, message: error.message }
            : { tick, error },
        );
      }

      const [priceA, priceB] = await Promise.all([
        exchangeA.getPriceSnapshot({
          symbol: input.config.btcSymbol,
          marketType: input.config.marketType,
          priceSource: input.config.priceSource,
        }),
        exchangeB.getPriceSnapshot({
          symbol: input.config.btcSymbol,
          marketType: input.config.marketType,
          priceSource: input.config.priceSource,
        }),
      ]);
      console.log("Price snapshots fetched", {
        tick,
        exchangeA: priceA.exchangeId,
        exchangeAPriceUsd: priceA.priceUsd,
        exchangeB: priceB.exchangeId,
        exchangeBPriceUsd: priceB.priceUsd,
        priceSource: input.config.priceSource,
      });

      // SignalEngine is stateless; constructing it per tick lets runtime
      // overrides of minPriceDiffUsd / leverage apply without a restart.
      const signalEngine = new SignalEngine({
        thresholdUsd: input.config.minPriceDiffUsd,
        leverage: input.config.leverage,
      });
      const spread = calculateSpread({
        exchangeA: priceA,
        exchangeB: priceB,
        thresholdUsd: input.config.minPriceDiffUsd,
      });
      const signal = signalEngine.evaluate(spread);
      console.log("Spread snapshot", {
        tick,
        symbol: spread.symbol,
        exchangeA: spread.exchangeA,
        exchangeB: spread.exchangeB,
        absoluteDiffUsd: spread.absoluteDiffUsd,
        thresholdMatched: spread.thresholdMatched,
      });
      if (signal) {
        const active = await input.db
          .select({ id: trades.id })
          .from(trades)
          .where(inArray(trades.status, [...activeTradeStatuses]))
          .orderBy(desc(trades.id));
        // F4: the suppression branch must NOT skip the tick tail — every
        // path reaches the botRunOnce break check and the sleep below
        // (the old `continue` hot-spun the loop while a trade was
        // active). The suppression query and check-then-insert semantics
        // are unchanged.
        if (
          shouldSuppressSignalForActiveTrades(active.map((trade) => trade.id))
        ) {
          console.log(
            "Signal suppressed because an active or unhedged trade exists",
            { tick, activeTradeId: active[0]?.id },
          );
        } else {
          const signalRow = {
            spreadId: signal.spreadId ? Number(signal.spreadId) : null,
            longExchange: signal.longExchange,
            shortExchange: signal.shortExchange,
            source: signal.priceSource,
            leverage: signal.leverage,
            thresholdUsd: signal.thresholdUsd,
            observedDiffUsd: signal.absoluteDiffUsd,
            reason: signal.reason,
            status: "notified",
            createdAt: signal.createdAt,
          };
          const created = await input.db.insert(signals).values(signalRow);
          const signalId = await resolveInsertedSignalId(
            input.db,
            created,
            signalRow,
          );
          console.warn("Trading signal created", {
            tick,
            signalId,
            symbol: signal.symbol,
            longExchange: signal.longExchange,
            shortExchange: signal.shortExchange,
            absoluteDiffUsd: signal.absoluteDiffUsd,
            thresholdUsd: signal.thresholdUsd,
            mode: input.config.botExecutionMode,
          });
          await input.notifier.notifySignal({
            ...signal,
            id: signalId ? String(signalId) : undefined,
          });
          if (input.config.openTrade.autoConfirm) {
            // Decoupled from the tick: execution runs on the shared serial
            // queue so price polling and monitoring continue while the
            // entry fills; the queue's per-job catch logs any failure.
            input.executionQueue.enqueue({
              description: `auto-confirm:signal-${signalId ?? 0}`,
              run: () =>
                autoConfirmSignalTrade({
                  config: input.config,
                  registry: input.registry,
                  db: input.db,
                  notifier: {
                    notifyUrgent: (text) => input.notifier.notifyUrgent(text),
                    notifyLimitTimeout: async ({ message }) => {
                      await input.notifier.notifyUrgent(message);
                    },
                  },
                  signalId: signalId ?? 0,
                  signal: {
                    symbol: signal.symbol,
                    marketType: input.config.marketType,
                    longExchange: signal.longExchange,
                    shortExchange: signal.shortExchange,
                  },
                }),
            });
          }
        }
      }
      console.log("Monitoring tick completed", {
        tick,
        durationMs: Date.now() - tickStartedAt.getTime(),
      });
    } catch (error) {
      console.error(
        "Polling tick failed",
        error instanceof Error
          ? { tick, message: error.message }
          : { tick, error },
      );
    }
    if (input.config.botRunOnce) break;
    await sleep(input.config.pricePollIntervalMs);
  }
  // F3: stop the monitor timer once the signal loop exits. Without this
  // the interval keeps the Node event loop alive and the process would
  // never exit after SIGINT/SIGTERM. An in-flight pass is left to finish
  // (it is bounded by the existing exchange timeouts); the module-local
  // process.once SIGINT/SIGTERM handlers stay the single shutdown source
  // of truth.
  clearInterval(monitorTimer);
}

async function resolveInsertedSignalId(
  db: Awaited<ReturnType<typeof getDb>>,
  created: unknown,
  row: {
    spreadId: number | null;
    longExchange: string;
    shortExchange: string;
    source: string;
    leverage: number;
    thresholdUsd: string;
    observedDiffUsd: string;
    reason: string;
    status: string;
    createdAt: Date;
  },
): Promise<number> {
  const insertId = extractInsertId(created);
  if (insertId !== undefined && insertId > 0) return insertId;

  const inserted = await db
    .select({ id: signals.id })
    .from(signals)
    .where(
      and(
        eq(signals.longExchange, row.longExchange),
        eq(signals.shortExchange, row.shortExchange),
        eq(signals.source, row.source),
        eq(signals.leverage, row.leverage),
        eq(signals.thresholdUsd, row.thresholdUsd),
        eq(signals.observedDiffUsd, row.observedDiffUsd),
        eq(signals.reason, row.reason),
        eq(signals.status, row.status),
      ),
    )
    .orderBy(desc(signals.id));

  return Number(inserted[0]?.id ?? 0);
}

let shuttingDown = false;
process.once("SIGINT", () => {
  shuttingDown = true;
});
process.once("SIGTERM", () => {
  shuttingDown = true;
});
function isShuttingDown() {
  return shuttingDown;
}
