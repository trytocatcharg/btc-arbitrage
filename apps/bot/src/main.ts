import {
  loadBotConfig,
  loadDotEnvFile,
  redactSecrets,
} from "@btc-arbitrage/config";
import { getDb } from "@btc-arbitrage/db";
import { createExchangeRegistry } from "./exchanges/registry.js";
import type { ArcusExecutionHandle } from "./exchanges/arcus/arcus-execution-adapter.js";
import { TelegramCommandPoller } from "./notifications/telegram-command-poller.js";
import { TelegramNotifier } from "./notifications/telegram-notifier.js";
import { runPollingLoop } from "./runtime/polling-loop.js";
import { ExecutionQueue } from "./trading/execution-queue.js";

async function main() {
  console.log("btc-arbitrage bot process booting", {
    pid: process.pid,
    nodeVersion: process.version,
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
  });

  const loadedEnvPath = loadDotEnvFile();
  console.log("Environment file status", {
    loaded: Boolean(loadedEnvPath),
    path: loadedEnvPath ?? null,
  });

  const config = loadBotConfig();
  if (config.risex.tradingEnabled) {
    console.warn(
      "RISEx live execution adapter is enabled; signed REST mutations require configured account and session signer credentials",
      {
        risexTradingEnabled: true,
        hasRisexAccountAddress: Boolean(config.risex.accountAddress),
        hasRisexSessionSignerPrivateKey: Boolean(
          config.risex.sessionSignerPrivateKey,
        ),
        botExecutionMode: config.botExecutionMode,
      },
    );
  }
  if (config.extended.tradingEnabled) {
    console.warn(
      "Extended live execution adapter is enabled; signed Stark REST mutations require API key, Stark private key and vault id",
      {
        extendedTradingEnabled: true,
        hasExtendedApiKey: Boolean(config.extended.apiKey),
        hasExtendedStarkPrivateKey: Boolean(config.extended.starkPrivateKey),
        hasExtendedVaultId: Boolean(config.extended.vaultId),
        botExecutionMode: config.botExecutionMode,
      },
    );
  }
  if (config.arcus.tradingEnabled) {
    console.warn(
      "Arcus live execution adapter is enabled; signed REST mutations require API key, Ed25519 private key and account address",
      {
        arcusTradingEnabled: true,
        hasArcusApiKey: Boolean(config.arcus.apiKey),
        hasArcusPrivateKey: Boolean(config.arcus.privateKey),
        hasArcusAccountAddress: Boolean(config.arcus.accountAddress),
        botExecutionMode: config.botExecutionMode,
      },
    );
  }
  if (config.openTrade.autoConfirm) {
    console.warn(
      "OPEN_TRADE_AUTO_CONFIRM is ENABLED: the bot will open trades automatically on signals WITHOUT Telegram operator confirmation",
      {
        openTradeAutoConfirm: true,
        botExecutionMode: config.botExecutionMode,
        minPriceDiffUsd: config.minPriceDiffUsd,
      },
    );
  }

  console.log(
    "Bot runtime config loaded",
    redactSecrets({
      database: {
        hostName: config.database.hostName,
        port: config.database.port,
        userName: config.database.userName,
        dbName: config.database.dbName,
        url: config.database.url,
      },
      exchangeA: config.exchangeA,
      exchangeB: config.exchangeB,
      symbol: config.btcSymbol,
      marketType: config.marketType,
      priceSource: config.priceSource,
      pricePollIntervalMs: config.pricePollIntervalMs,
      minPriceDiffUsd: config.minPriceDiffUsd,
      leverage: config.leverage,
      botExecutionMode: config.botExecutionMode,
      botRunOnce: config.botRunOnce,
      telegramEnabled: config.telegram.enabled,
      telegramAlertCooldownMs: config.telegram.alertCooldownMs,
    }),
  );

  console.log("Connecting to database...");
  const db = await getDb();
  console.log("Database connected");
  // await validateDbConnection(config.database.url);
  // console.log('connection succesfull');

  console.log("Initializing exchange registry");
  const registry = createExchangeRegistry(config);

  // One-time execution setup, hoisted from the per-trade preflight: sets
  // the account leverage on RISEx and initializes Extended order-signing
  // WASM. These are process-lifetime steps, not per-trade checks —
  // re-running them on every trade added avoidable latency to the entry
  // path. Fail fast here: if live trading is enabled but the venue
  // rejects the setup, better to die at boot than mid-trade.
  for (const exchangeId of [config.exchangeA, config.exchangeB]) {
    const tradingEnabled =
      (exchangeId === "risex" && config.risex.tradingEnabled) ||
      (exchangeId === "extended" && config.extended.tradingEnabled) ||
      (exchangeId === "arcus" && config.arcus.tradingEnabled);
    if (!tradingEnabled) continue;
    const adapter = registry.get(exchangeId);
    if (!adapter.execution) continue;
    // Log before the await so a stalled boot shows exactly which exchange
    // and which step (network calls carry a 10 s timeout) is in flight.
    console.log("Running execution preflight at startup", {
      exchange: exchangeId,
      symbol: config.btcSymbol,
      leverage: config.leverage,
    });
    try {
      await adapter.execution.validateExecutionPreflight({
        symbol: config.btcSymbol,
        leverage: config.leverage,
      });
    } catch (error) {
      console.error("Execution preflight failed at startup", {
        exchange: exchangeId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    console.log("Execution preflight completed at startup", {
      exchange: exchangeId,
    });
  }

  // Arcus routing fees: perp fees MUST be read from the public live
  // GET /v1/feetiers table (docs/exchanges/arcus.md). There is no
  // per-account tier endpoint, so the base tier (level 0 — the most
  // expensive, conservative tier) is used. Explicit env overrides
  // (ARCUS_MAKER_FEE_BPS/ARCUS_TAKER_FEE_BPS) win and skip the fetch.
  // Fail fast: an unreachable fee table must die at boot, not mid-trade.
  if (
    (config.exchangeA === "arcus" || config.exchangeB === "arcus") &&
    config.arcus.tradingEnabled
  ) {
    if (
      config.arcus.makerFeeBps !== undefined &&
      config.arcus.takerFeeBps !== undefined
    ) {
      console.log("Arcus fee schedule using env overrides", {
        source: "ARCUS_MAKER_FEE_BPS/ARCUS_TAKER_FEE_BPS",
        makerFeeBps: config.arcus.makerFeeBps,
        takerFeeBps: config.arcus.takerFeeBps,
      });
    } else {
      const arcusExecution = registry.get("arcus")
        .execution as ArcusExecutionHandle | undefined;
      if (!arcusExecution)
        throw new Error(
          "Arcus execution adapter is unavailable; " +
            "set ARCUS_MAKER_FEE_BPS/ARCUS_TAKER_FEE_BPS to bypass live resolution",
        );
      try {
        const schedule = await arcusExecution.getBaseFeeSchedule();
        config.arcus.makerFeeBps = Number(schedule.makerBps);
        config.arcus.takerFeeBps = Number(schedule.takerBps);
        console.log(
          "Arcus base-tier fee schedule resolved from live fee table",
          {
            source: "/v1/feetiers",
            tier: "base (level 0)",
            makerFeeBps: config.arcus.makerFeeBps,
            takerFeeBps: config.arcus.takerFeeBps,
          },
        );
      } catch (error) {
        throw new Error(
          "Failed to resolve Arcus fees from GET /v1/feetiers: " +
            (error instanceof Error ? error.message : String(error)) +
            "; set ARCUS_MAKER_FEE_BPS/ARCUS_TAKER_FEE_BPS to bypass " +
            "live resolution",
        );
      }
    }
  }
  const notifier = new TelegramNotifier(config.telegram);
  const executionQueue = new ExecutionQueue();
  const commandPoller = config.telegram.enabled
    ? new TelegramCommandPoller(config, db, registry, fetch, executionQueue)
    : undefined;
  if (commandPoller) {
    try {
      await commandPoller.configureAvailableCommands();
      console.log("Telegram commands configured", {
        scope: "chat",
        commands: ["config", "trade"],
      });
    } catch (error) {
      console.warn(
        "Telegram command configuration failed; monitoring will continue",
        error instanceof Error ? { message: error.message } : { error },
      );
    }
  }

  console.log("Starting monitoring loop");
  await runPollingLoop({
    config,
    registry,
    notifier,
    db,
    commandPoller,
    executionQueue,
  });
  console.log("Monitoring loop stopped", {
    stoppedAt: new Date().toISOString(),
  });
}

main().catch((error: unknown) => {
  console.error(
    "Bot stopped after fatal error",
    redactSecrets(
      error instanceof Error
        ? { message: error.message, stack: error.stack }
        : error,
    ),
  );
  process.exitCode = 1;
});
