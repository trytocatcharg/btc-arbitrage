import { calculateSpread } from "@btc-arbitrage/domain";
import { GOLD_SILVER_SYMBOL } from "@btc-arbitrage/domain";
import type { BotConfig } from "@btc-arbitrage/config";
import type { SpreadSnapshot } from "@btc-arbitrage/domain";
import type { ExchangeAdapter } from "@btc-arbitrage/exchange-core";
import { SignalEngine } from "../signals/signal-engine.js";
import type { Notifier } from "../notifications/notifier.js";
import type { TelegramInlineKeyboard } from "../notifications/telegram-notifier.js";
import type { getDb } from "@btc-arbitrage/db";
import {
  signals,
  activeTradeStatuses,
  spreadSnapshots,
  trades,
} from "@btc-arbitrage/db";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { monitorTrades } from "../trading/trade-monitor.js";
import { sampleUnhedgedLegs } from "../trading/unhedged-sampler.js";
import { recoverStaleClosingTrades } from "../trading/close-recovery-monitor.js";
import { runPositionReconciliation } from "../trading/position-reconciler.js";
import { runDataRetention } from "../retention/data-retention.js";
import { startRetentionScheduler } from "../retention/retention-scheduler.js";
import { shouldSuppressSignalForActiveTrades } from "../trading/trade-guards.js";
import type { ExecutionQueue } from "../trading/execution-queue.js";
import { autoConfirmSignalTrade } from "../trading/open-trade-factory.js";
import { extractInsertId } from "../db-result.js";
import type { BotControl } from "./runtime-control.js";
import {
  createArcusMarketDataClient,
  type ArcusMarketDataClient,
} from "../exchanges/arcus/arcus-client.js";
import { MetalRatioEngine } from "../metal-ratio/metal-ratio-engine.js";
import {
  GOLD_MARKET,
  GOLD_SILVER_TIMEFRAME_MS,
  loadMetalRatioWarmupCloses,
  SILVER_MARKET,
} from "../metal-ratio/metal-ratio-warmup.js";
import { persistRatioSnapshot } from "../metal-ratio/metal-ratio-store.js";
import { evaluateMetalTradeExitTriggers } from "../metal-ratio/metal-trade-monitor.js";

export interface ExchangeRegistry {
  get(id: string): ExchangeAdapter;
}

export interface CommandPoller {
  pollOnce(): Promise<void>;
}

export async function runPollingLoop(input: {
  config: BotConfig;
  registry: ExchangeRegistry;
  // Intersection with the keyboard-capable urgent signature: the position
  // reconciler's arm alert carries the Close-position inline button, so
  // the notify lambda forwards an optional TelegramInlineKeyboard. The
  // base Notifier contract stays one-arg for every other caller.
  notifier: Notifier & {
    notifyUrgent(
      text: string,
      keyboard?: TelegramInlineKeyboard,
    ): Promise<void>;
  };
  db: Awaited<ReturnType<typeof getDb>>;
  commandPoller?: CommandPoller;
  executionQueue: ExecutionQueue;
  control: BotControl;
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
  // Set when the paused monitor-skip line has been logged, so a paused
  // bot logs the skip once instead of every second.
  let pauseSkipLogged = false;
  const monitorTimer = setInterval(() => {
    // F3: never start a new pass once shutdown was requested; the timer
    // itself is cleared after the signal loop exits.
    if (isShuttingDown()) return;
    // Never start a pass while paused or restarting either: the defensive
    // monitors keep working while paused (see the tick pause check below),
    // but a fresh pass overlapping a restart exit would race the exit.
    if (input.control.isRestartRequested()) return;
    if (input.control.isPaused()) {
      // Log only on the paused transition: at a 1 s cadence a per-pass
      // line would spam the log for the whole paused period.
      if (!pauseSkipLogged) {
        pauseSkipLogged = true;
        console.log("Monitor pass skipped: bot paused", { pass });
      }
      return;
    }
    pauseSkipLogged = false;
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
          config: input.config,
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
        await sampleUnhedgedLegs({
          db: input.db,
          registry: input.registry,
          config: input.config,
        });
      } catch (error) {
        console.error(
          "Unhedged sampling failed",
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
      try {
        // The reconciler owns its own cadence (POSITION_RECONCILE_INTERVAL_MS,
        // checked internally) — the pass invokes it unconditionally.
        await runPositionReconciliation({
          db: input.db,
          registry: input.registry,
          config: input.config,
          notify: (text, keyboard) =>
            input.notifier.notifyUrgent(text, keyboard),
        });
      } catch (error) {
        console.error(
          "Position reconciliation failed",
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

  // Step 4 (trade-execution-queue): Telegram command polling runs on
  // its own wall-clock interval instead of inside the signal tick, so a
  // slow or hung Telegram API can no longer delay price polling and
  // signal evaluation. Cadence reuses PRICE_POLL_INTERVAL_MS — no new
  // env keys. Unlike the monitor interval this one is NOT gated on the
  // pause flags: an operator keeps full control of a paused bot (this
  // was the tick's original ordering and is preserved deliberately).
  let commandPollInFlight = false;
  // Set when the in-flight skip line has been logged, so a slow poll
  // (up to TELEGRAM_REQUEST_TIMEOUT_MS) logs the skip once instead of
  // every second.
  let commandPollSkipLogged = false;
  const telegramTimer = setInterval(() => {
    // F3: never start a new poll once shutdown was requested; the timer
    // itself is cleared after the signal loop exits.
    if (isShuttingDown()) return;
    // Same restart contract as the monitor interval: no fresh poll
    // overlapping a restart exit.
    if (input.control.isRestartRequested()) return;
    // F2: re-entrancy guard mirroring the monitor interval — check and
    // set synchronously so interval ticks can never overlap an
    // in-flight poll; reset in the finally of runTelegramPoll().
    if (commandPollInFlight) {
      if (!commandPollSkipLogged) {
        commandPollSkipLogged = true;
        console.warn("Telegram poll skipped: previous poll still in flight");
      }
      return;
    }
    commandPollSkipLogged = false;
    commandPollInFlight = true;
    // Floating promise guarded by the in-flight flag and by the catch
    // inside runTelegramPoll(), so there is no unhandled-rejection path.
    void runTelegramPoll();
  }, input.config.pricePollIntervalMs);

  async function runTelegramPoll(): Promise<void> {
    try {
      await input.commandPoller?.pollOnce();
    } catch (error) {
      console.error(
        "Telegram command polling failed",
        error instanceof Error ? { message: error.message } : { error },
      );
    } finally {
      commandPollInFlight = false;
    }
  }

  const retentionScheduler = startRetentionScheduler({
    db: input.db,
    config: input.config,
    isShuttingDown,
  });

  // Gold/silver ratio strategy (gold-silver-decouple): no longer a
  // selectable pair. The context initializes lazily on the first tick
  // with an ACTIVE metal trade (runMetalRatioPass gates on that) and
  // re-warms its candle history when the ratio series has gone stale
  // (e.g. the bot restarted mid-trade or the trade stayed open longer
  // than the candle timeframe without a tick).
  interface MetalRatioContext {
    client: ArcusMarketDataClient;
    engine: MetalRatioEngine;
    /** 0 until the first warmup (successful or cold) has run. */
    warmedUpAtMs: number;
    /** Wall clock of the most recent ratio tick; 0 if never. */
    lastTickAtMs: number;
  }
  let metalRatio: MetalRatioContext | undefined;

  async function ensureMetalRatioContext(): Promise<MetalRatioContext> {
    if (!metalRatio) {
      metalRatio = {
        client: createArcusMarketDataClient(input.config.arcus),
        engine: new MetalRatioEngine({
          rsiPeriod: input.config.goldSilver.rsiPeriod,
          rsiConfirmBand: input.config.goldSilver.rsiConfirmBand,
          timeframeMs:
            GOLD_SILVER_TIMEFRAME_MS[input.config.goldSilver.candleTimeframe],
        }),
        warmedUpAtMs: 0,
        lastTickAtMs: 0,
      };
    }
    const stalenessMs =
      2 *
      GOLD_SILVER_TIMEFRAME_MS[input.config.goldSilver.candleTimeframe];
    const seriesStale =
      metalRatio.lastTickAtMs > 0 &&
      Date.now() - metalRatio.lastTickAtMs > stalenessMs;
    if (metalRatio.warmedUpAtMs === 0 || seriesStale) {
      try {
        const closes = await loadMetalRatioWarmupCloses({
          client: metalRatio.client,
          timeframe: input.config.goldSilver.candleTimeframe,
          candleLimit: input.config.goldSilver.candleLimit,
        });
        // init() resets the confirmed side, so the first tick after a
        // (re-)warmup announces the current regime — an intentional
        // boot/switch-time status alert.
        metalRatio.engine.init(closes);
        metalRatio.warmedUpAtMs = Date.now();
        console.log("Gold/silver ratio monitor ready", {
          rewarm: seriesStale,
          timeframe: input.config.goldSilver.candleTimeframe,
          warmupCloses: closes.length,
          rsiPeriod: input.config.goldSilver.rsiPeriod,
          rsiConfirmBand: input.config.goldSilver.rsiConfirmBand,
        });
      } catch (error) {
        // Cold start is acceptable degradation (RSI stays undefined until
        // enough live ticks); only stamp warmedUpAtMs so the failure does
        // not retry the warmup on every single tick.
        console.warn(
          "Gold/silver ratio warmup failed; starting cold (RSI stays undefined until enough live ticks)",
          error instanceof Error ? { message: error.message } : { error },
        );
        metalRatio.engine.init([]);
        metalRatio.warmedUpAtMs = Date.now();
      }
    }
    return metalRatio;
  }

  // Restart is cooperative: the loop exits when control.requestRestart()
  // sets the flag, the monitor timer is cleared below, and the process
  // exits cleanly (code 0) when main() returns; Docker (restart:
  // unless-stopped) boots the container again.
  while (!isShuttingDown() && !input.control.isRestartRequested()) {
    tick += 1;
    const tickStartedAt = new Date();
    console.log("Monitoring tick started", {
      tick,
      startedAt: tickStartedAt.toISOString(),
    });

    try {
      // Step 4 (trade-execution-queue): in long-running mode Telegram is
      // polled on its own interval (started above). Run-once mode has no
      // timer lifetime — the process exits after this tick — so it keeps
      // the single inline poll it always had.
      if (input.config.botRunOnce) {
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
      }
      // Step 3 (trade-execution-queue): in long-running mode data
      // retention fires on its own daily timer (quiet hour), not here.
      // Run-once mode has no timer lifetime — the process exits after
      // this tick — so it keeps the single inline pass it always had.
      if (input.config.botRunOnce) {
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
      }

      // Pause check stays BELOW the run-once Telegram/retention passes
      // above so run-once mode keeps its original ordering. In
      // long-running mode the Telegram interval is not gated on the
      // pause flags either, so an operator keeps full control while
      // paused. Only price snapshots, spread evaluation, signal
      // emission and auto-confirm are skipped.
      if (input.control.isRestartRequested()) {
        // A /bot restart callback sets the flag (in the Telegram poll
        // interval or in a run-once poll above). Skip the signal pass
        // so no signal can fire — and no auto-confirm job can be
        // enqueued — between the no-open-position guard and the loop
        // exit. The while condition ends the loop before the next tick.
        console.log("Restart requested; signal pass skipped", { tick });
      } else if (input.control.isPaused()) {
        console.log("Monitoring tick paused", { tick });
        // gold-silver-decouple: the metal exit tick SURVIVES the operator
        // pause. The metal SL/TP/time-stop triggers are bot-evaluated (no
        // resting exchange protection orders), so skipping them while
        // paused would leave an open metal position unprotected. The pass
        // no-ops unless a G/S trade is active, so an idle paused bot still
        // makes no Arcus calls.
        await runMetalRatioPass(tick);
      } else {
        await runSignalPass(tick);
        await runMetalRatioPass(tick);
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
    // waitOrSleep resolves early on resume/restart so a paused bot reacts
    // promptly to /bot resume and a restart exits the loop without
    // waiting out the full poll interval.
    await input.control.waitOrSleep(input.config.pricePollIntervalMs);
  }
  // F3: stop the monitor timer once the signal loop exits. Without this
  // the interval keeps the Node event loop alive and the process would
  // never exit after SIGINT/SIGTERM. An in-flight pass is left to finish
  // (it is bounded by the existing exchange timeouts); the module-local
  // process.once SIGINT/SIGTERM handlers stay the single shutdown source
  // of truth.
  clearInterval(monitorTimer);
  clearInterval(telegramTimer);
  // F3: same shutdown contract for the retention scheduler — without
  // stop() a pending daily timer would keep the Node event loop alive
  // and the process would never exit (relevant in run-once mode too,
  // where the scheduler started but never fired).
  retentionScheduler.stop();

  // Price snapshots + spread evaluation + signal emission + auto-confirm
  // enqueue, extracted from the tick so a paused bot skips it wholesale.
  async function runSignalPass(tick: number): Promise<void> {
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
    // Every tick is persisted so /lastsignal can show recent spreads
    // regardless of the threshold. Failure-isolated on purpose: a logging
    // failure must never block signal emission for the tick.
    const spreadId = await persistSpreadSnapshot(input.db, spread);
    const signal = signalEngine.evaluate(spread);
    console.log("Spread snapshot", {
      tick,
      spreadId,
      symbol: spread.symbol,
      exchangeA: spread.exchangeA,
      exchangeB: spread.exchangeB,
      absoluteDiffUsd: spread.absoluteDiffUsd,
      thresholdMatched: spread.thresholdMatched,
    });
    if (signal) {
      // gold-silver-decouple: active GOLD/SILVER metal trades must NOT
      // suppress spread signals — the two strategies coexist, so the
      // suppression query excludes them.
      const active = await input.db
        .select({ id: trades.id })
        .from(trades)
        .where(
          and(
            inArray(trades.status, [...activeTradeStatuses]),
            ne(trades.symbol, GOLD_SILVER_SYMBOL),
          ),
        )
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
          spreadId: spreadId ?? null,
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
  }

  // Gold/silver metal-trade tick (gold-silver-decouple): runs alongside
  // the BTC spread pass, but ONLY while a G/S trade is active — there is
  // no idle monitor: no warmup, no ratio_snapshots rows, no RSI alerts
  // (entry is operator-driven from /ratio). Per active tick: fetch GLD/SLV
  // marks, feed the RSI engine, persist one ratio snapshot, and evaluate
  // the exit triggers (SL / RSI-TP floor / time-stop). Own try/catch so a
  // metal failure never breaks the tick; persistRatioSnapshot swallows DB
  // errors.
  async function runMetalRatioPass(tick: number): Promise<void> {
    try {
      // Active-trade gate: one cheap DB probe per tick replaces the old
      // pair-selection switch. Mirrors loadActiveMetalTrade's filter
      // (metal-trade-service.ts) but only needs existence.
      const activeMetal = await input.db
        .select({ id: trades.id })
        .from(trades)
        .where(
          and(
            eq(trades.symbol, GOLD_SILVER_SYMBOL),
            inArray(trades.status, [...activeTradeStatuses]),
          ),
        )
        .limit(1);
      if (activeMetal.length === 0) return;

      // Cadence gate: the ratio tick runs at GOLDSILVER_PRICE_POLL_INTERVAL_MS
      // (default 5 s), not at the 1 Hz BTC tick. The engine works on candle
      // buckets, so 1 Hz polling only burns Arcus rate-limit budget. A 0
      // value follows the BTC tick (legacy behavior).
      const pollMs = input.config.goldSilver.pricePollIntervalMs;
      if (
        pollMs > 0 &&
        metalRatio &&
        metalRatio.lastTickAtMs > 0 &&
        Date.now() - metalRatio.lastTickAtMs < pollMs
      ) {
        return;
      }
      const ctx = await ensureMetalRatioContext();
      ctx.lastTickAtMs = Date.now();
      const calculatedAt = new Date();
      // ONE /v1/prices call per tick: mark prices only. The Arcus BBO
      // endpoint is rate-limited (429s after a few minutes at 1 Hz) and
      // the ratio monitor does not need it; /v1/prices is documented as
      // safe to poll frequently.
      const marks = await ctx.client.getMarkPricesUsd([GOLD_MARKET, SILVER_MARKET]);
      const gold = { priceUsd: marks[GOLD_MARKET] };
      const silver = { priceUsd: marks[SILVER_MARKET] };
      const result = ctx.engine.onTick({
        goldPriceUsd: gold.priceUsd,
        silverPriceUsd: silver.priceUsd,
        calculatedAt,
      });
      await persistRatioSnapshot(input.db, {
        goldPriceUsd: gold.priceUsd,
        silverPriceUsd: silver.priceUsd,
        ratio: result.ratio,
        rsi: result.rsi,
        side: result.side,
        crossed: result.crossed,
        calculatedAt,
      });

      // Exit triggers for the active pair trade (SL / TP floor / time-stop).
      // Failure-isolated: a trigger-eval error must never break the tick.
      try {
        const arcusAdapter = input.registry.get("arcus");
        if (arcusAdapter.execution) {
          await evaluateMetalTradeExitTriggers(
            {
              db: input.db,
              config: input.config,
              execution: arcusAdapter.execution,
              notify: (text) => input.notifier.notifyUrgent(text),
              notifyUrgent: (text) => input.notifier.notifyUrgent(text),
              enqueue: (job) => input.executionQueue.enqueue(job),
            },
            {
              crossed: result.crossed,
              side: result.side,
              goldPriceUsd: gold.priceUsd,
              silverPriceUsd: silver.priceUsd,
            },
          );
        }
      } catch (error) {
        console.error(
          "Gold/silver exit trigger evaluation failed",
          error instanceof Error
            ? { tick, message: error.message }
            : { tick, error },
        );
      }
    } catch (error) {
      console.error(
        "Gold/silver ratio tick failed",
        error instanceof Error
          ? { tick, message: error.message }
          : { tick, error },
      );
    }
  }
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

/** Persists one spread tick into spread_snapshots so /lastsignal can show
 * recent spreads regardless of the threshold. Failure-isolated on
 * purpose: returns null on error so a logging failure never blocks
 * signal emission for the tick. */
async function persistSpreadSnapshot(
  db: Awaited<ReturnType<typeof getDb>>,
  spread: SpreadSnapshot,
): Promise<number | null> {
  try {
    const result = await db.insert(spreadSnapshots).values({
      symbol: spread.symbol,
      marketType: spread.marketType,
      priceSource: spread.priceSource,
      exchangeA: spread.exchangeA,
      exchangeB: spread.exchangeB,
      exchangeAPriceUsd: spread.exchangeAPriceUsd,
      exchangeBPriceUsd: spread.exchangeBPriceUsd,
      absoluteDiffUsd: spread.absoluteDiffUsd,
      diffBps: spread.diffBps,
      direction: spread.direction,
      thresholdUsd: spread.thresholdUsd,
      thresholdMatched: spread.thresholdMatched,
      calculatedAt: spread.calculatedAt,
    });
    const insertId = extractInsertId(result);
    return insertId !== undefined && insertId > 0 ? insertId : null;
  } catch (error) {
    console.error(
      "Failed to persist spread snapshot",
      error instanceof Error ? { message: error.message } : { error },
    );
    return null;
  }
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
