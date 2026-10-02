import type { BotConfig } from "@btc-arbitrage/config";
import type { getDb } from "@btc-arbitrage/db";
import type { ExchangeAdapter } from "@btc-arbitrage/exchange-core";
import type { MarketType, ExchangeId } from "@btc-arbitrage/domain";
import { OpenTradeService, type OpenTradeOptions } from "./open-trade.js";
import { DbPreviewStore } from "./db-preview-store.js";
import {
  buildTradeOpenedSummary,
  formatEdgeClosedNotice,
} from "./opened-trade-summary.js";

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
      arcus: {
        // When Arcus trading is enabled, main.ts startup resolves these
        // from GET /v1/feetiers (or an env override) before any trade can
        // open; dry-run monitoring uses "0" and does not execute.
        makerBps:
          config.arcus.makerFeeBps !== undefined
            ? String(config.arcus.makerFeeBps)
            : "0",
        takerBps:
          config.arcus.takerFeeBps !== undefined
            ? String(config.arcus.takerFeeBps)
            : "0",
      },
      variational: {
        makerBps: config.openTrade.variationalMakerFeeBps,
        takerBps: config.openTrade.variationalTakerFeeBps,
      },
    },
    notifyUrgent: notify.notifyUrgent,
    notifyLimitTimeout: notify.notifyLimitTimeout,
    autoConfirm: config.openTrade.autoConfirm,
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
    // The Telegram-confirm path reports the outcome by editing the
    // operator's message; auto-confirm has no such message, so every
    // outcome must be pushed explicitly or the operator only learns
    // about the trade when the legs close.
    try {
      if (outcome?.outcome === "opened") {
        const summary = await buildTradeOpenedSummary(input.db, preview.token);
        await input.notifier.notifyUrgent(`🤖 Auto-trade\n${summary}`);
      } else if (outcome?.outcome === "edge_closed") {
        await input.notifier.notifyUrgent(
          `🤖 Auto-trade\n${formatEdgeClosedNotice(outcome)}`,
        );
      } else if (outcome?.outcome === "cancelled") {
        // Auto-trading: el aviso de límite expirado sin fill queda
        // silenciado a propósito — un chat sin operador solo acumula
        // ruido. El cambio de estado igual queda en la DB/logs.
        console.log("Auto-confirm: trade cancelado (el límite expiró sin fill)", {
          signalId: input.signalId,
          token: preview.token,
        });
      } else {
        await input.notifier.notifyUrgent(
          `❌ Auto-trade ${preview.token.slice(0, 8)} terminó sin un ` +
            `resultado definido. Revisá los logs antes de asumir que abrió.`,
        );
      }
    } catch (notifyError) {
      // A failed notification must not mark the trade itself as failed —
      // the open already completed above.
      console.error("Auto-confirm outcome notification failed", {
        signalId: input.signalId,
        token: preview.token,
        message:
          notifyError instanceof Error
            ? notifyError.message
            : String(notifyError),
      });
    }
  } catch (error) {
    console.error("Auto-confirm trade failed", {
      signalId: input.signalId,
      message: error instanceof Error ? error.message : String(error),
    });
    try {
      await input.notifier.notifyUrgent(
        `❌ Auto-trade falló en la señal ${input.signalId}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    } catch (notifyError) {
      console.error("Auto-confirm failure notification failed", {
        signalId: input.signalId,
        message:
          notifyError instanceof Error
            ? notifyError.message
            : String(notifyError),
      });
    }
  }
}
