import type { BotConfig } from "@btc-arbitrage/config";
import type { getDb } from "@btc-arbitrage/db";
import type { ExchangeAdapter } from "@btc-arbitrage/exchange-core";
import type { MarketType, ExchangeId } from "@btc-arbitrage/domain";
import { OpenTradeService, type OpenTradeOptions } from "./open-trade.js";
import { DbPreviewStore } from "./db-preview-store.js";

export interface OpenTradeNotify {
  notifyUrgent: (text: string) => Promise<void>;
  notifyLimitTimeout: (input: {
    token: string;
    message: string;
  }) => Promise<void>;
}

/** Single source of truth for wiring OpenTradeOptions from BotConfig —
 * shared by the Telegram command poller (operator clicks) and the
 * auto-confirm path (signal-triggered opens). The notify callbacks differ
 * per call site (Telegram buttons vs plain urgent messages); everything
 * else must stay identical so both paths behave the same. */
export function buildOpenTradeOptions(
  config: BotConfig,
  notify: OpenTradeNotify,
): OpenTradeOptions {
  return {
    notionalUsd: config.openTrade.notionalUsd,
    leverage: config.leverage,
    ttlMs: config.openTrade.previewTtlMs,
    quoteMaxAgeMs: config.openTrade.quoteMaxAgeMs,
    limitTimeoutMs: config.openTrade.limitTimeoutMs,
    limitRepriceIntervalMs: config.openTrade.limitRepriceIntervalMs,
    entryImproveTicks: config.openTrade.entryImproveTicks,
    residualDeltaToleranceBase: config.openTrade.residualDeltaToleranceBase,
    takeProfitPercent: config.openTrade.takeProfitPercent,
    stopLossPercent: config.openTrade.stopLossPercent,
    minProfitUsd: config.openTrade.minProfitUsd,
    maxLossUsd: config.openTrade.maxLossUsd,
    slippageBps: config.openTrade.slippageBps,
    minSpreadUsd: config.minPriceDiffUsd,
    priceSource: config.priceSource,
    fees: {
      risex: {
        makerBps: config.openTrade.risexMakerFeeBps,
        takerBps: config.openTrade.risexTakerFeeBps,
      },
      extended: {
        makerBps: config.openTrade.extendedMakerFeeBps,
        takerBps: config.openTrade.extendedTakerFeeBps,
      },
      arcus: { makerBps: "0", takerBps: "0" },
      variational: {
        makerBps: config.openTrade.variationalMakerFeeBps,
        takerBps: config.openTrade.variationalTakerFeeBps,
      },
    },
    notifyUrgent: notify.notifyUrgent,
    notifyLimitTimeout: notify.notifyLimitTimeout,
  };
}

export function createOpenTradeService(input: {
  config: BotConfig;
  registry: { get(id: string): ExchangeAdapter };
  db: Awaited<ReturnType<typeof getDb>>;
  notify: OpenTradeNotify;
}): OpenTradeService {
  return new OpenTradeService(
    input.registry,
    new DbPreviewStore(input.db),
    buildOpenTradeOptions(input.config, input.notify),
  );
}

/** OPEN_TRADE_AUTO_CONFIRM path: open the trade immediately when a signal
 * is created, without operator confirmation. Failures are logged and
 * swallowed — the monitoring loop must keep running, and the next signal
 * above threshold retries. Guard rails still apply: signal suppression
 * while a trade is active, hasBlockingExecution inside confirm(), the
 * viability watch, and the anti-chase guard. */
export async function autoConfirmSignalTrade(input: {
  config: BotConfig;
  registry: { get(id: string): ExchangeAdapter };
  db: Awaited<ReturnType<typeof getDb>>;
  notifier: OpenTradeNotify;
  signalId: number;
  signal: {
    symbol: string;
    marketType: MarketType;
    longExchange: string;
    shortExchange: string;
  };
}): Promise<void> {
  console.warn("Auto-confirm: opening trade without operator confirmation", {
    signalId: input.signalId,
    symbol: input.signal.symbol,
    longExchange: input.signal.longExchange,
    shortExchange: input.signal.shortExchange,
  });
  try {
    const service = createOpenTradeService({
      config: input.config,
      registry: input.registry,
      db: input.db,
      notify: input.notifier,
    });
    const preview = await service.createPreview({
      signalId: input.signalId,
      symbol: input.signal.symbol,
      marketType: input.signal.marketType,
      exchanges: [input.signal.longExchange, input.signal.shortExchange] as [
        ExchangeId,
        ExchangeId,
      ],
    });
    const outcome = await service.confirm(preview.token);
    console.warn("Auto-confirm trade completed", {
      signalId: input.signalId,
      token: preview.token,
      outcome: outcome?.outcome ?? "undefined",
    });
  } catch (error) {
    console.error("Auto-confirm trade failed", {
      signalId: input.signalId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
