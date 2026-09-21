import type { BotConfig } from "@btc-arbitrage/config";
import type { getDb } from "@btc-arbitrage/db";
import { signals, tradeLegs, tradePreviews } from "@btc-arbitrage/db";
import { eq } from "drizzle-orm";
import { parseDecimal } from "@btc-arbitrage/domain";
import {
  buildTradeSummaryMessage,
  type ExchangeRegistryLike,
} from "./trade-summary.js";
import {
  isAllowedTelegramChat,
  isAllowedTelegramUser,
  normalizeTelegramChatId,
  type FetchLike,
} from "./telegram-notifier.js";
import { DbPreviewStore } from "../trading/db-preview-store.js";
import {
  OpenTradeService,
  type ConfirmOutcome,
  type OpenTradePreview,
} from "../trading/open-trade.js";

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id?: number;
    text?: string;
    from?: {
      id?: string | number;
    };
    chat?: {
      id?: string | number;
    };
  };
  callback_query?: {
    id: string;
    data?: string;
    from?: {
      id?: string | number;
    };
    message?: {
      message_id?: number;
      chat?: {
        id?: string | number;
      };
    };
  };
}

export interface TelegramUpdatesResponse {
  ok: boolean;
  result?: TelegramUpdate[];
}

export interface TelegramApiResponse {
  ok: boolean;
  description?: string;
}

const AVAILABLE_COMMANDS = [
  {
    command: "config",
    description: "Show active bot configuration",
  },
  {
    command: "trade",
    description: "Show open trade summary",
  },
] as const;

export class TelegramCommandPoller {
  private offset = 0;

  constructor(
    private readonly config: BotConfig,
    private readonly db: Awaited<ReturnType<typeof getDb>>,
    private readonly registry: ExchangeRegistryLike,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async configureAvailableCommands(): Promise<void> {
    if (!this.config.telegram.enabled) return;
    if (!this.config.telegram.botToken || !this.config.telegram.chatId) return;

    const response = await this.fetchImpl(
      `https://api.telegram.org/bot${this.config.telegram.botToken}/setMyCommands`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commands: AVAILABLE_COMMANDS,
          scope: {
            type: "chat",
            chat_id: normalizeTelegramChatId(this.config.telegram.chatId),
          },
        }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Telegram setMyCommands failed with HTTP ${response.status}`,
      );
    }

    const payload = (await response.json()) as TelegramApiResponse;
    if (!payload.ok) {
      throw new Error(
        `Telegram setMyCommands returned ok=false${payload.description ? `: ${payload.description}` : ""}`,
      );
    }
  }

  async pollOnce(): Promise<void> {
    if (!this.config.telegram.enabled) return;
    if (!this.config.telegram.botToken || !this.config.telegram.chatId) return;

    const updates = await this.fetchUpdates();
    for (const update of updates) {
      this.offset = Math.max(this.offset, update.update_id + 1);
      await this.handleUpdate(update);
    }
  }

  private async fetchUpdates(): Promise<TelegramUpdate[]> {
    let url: URL;
    try {
      url = new URL(
        `https://api.telegram.org/bot${this.config.telegram.botToken}/getUpdates`,
      );
    } catch {
      throw new Error(
        "Invalid TELEGRAM_BOT_TOKEN: failed to construct Telegram API URL.",
      );
    }
    url.searchParams.set("offset", String(this.offset));
    url.searchParams.set("timeout", "0");
    url.searchParams.set(
      "allowed_updates",
      JSON.stringify(["message", "callback_query"]),
    );

    const response = await this.fetchImpl(url.toString());
    if (!response.ok) {
      throw new Error(
        `Telegram getUpdates failed with HTTP ${response.status}`,
      );
    }

    const payload = (await response.json()) as TelegramUpdatesResponse;
    if (!payload.ok) {
      throw new Error("Telegram getUpdates returned ok=false");
    }

    return payload.result ?? [];
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }
    const message = update.message;
    if (!message) return;

    const text = message?.text?.trim();
    if (!text) return;

    if (!isAllowedTelegramChat(message.chat, this.config.telegram.chatId!)) {
      console.warn("Telegram command ignored from unauthorized chat", {
        updateId: update.update_id,
        chatId: message.chat?.id,
      });
      return;
    }
    if (!isAllowedTelegramUser(message.from, this.config.telegram.chatId!)) {
      console.warn("Telegram command ignored from unauthorized user", {
        updateId: update.update_id,
        userId: message.from?.id,
        chatId: message.chat?.id,
      });
      return;
    }

    try {
      if (isTelegramCommand(text, "config")) {
        await this.sendMessage(formatActiveConfigSummary(this.config));
        return;
      }

      if (isTelegramCommand(text, "trade")) {
        await this.sendMessage(
          await buildTradeSummaryMessage({
            db: this.db,
            registry: this.registry,
          }),
        );
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Telegram command failed", {
        updateId: update.update_id,
        command: text,
        message,
      });
      await this.sendMessage(`Command failed\n${message}`);
      return;
    }
  }

  private async handleCallback(
    callback: NonNullable<TelegramUpdate["callback_query"]>,
  ): Promise<void> {
    if (
      !isAllowedTelegramChat(
        callback.message?.chat,
        this.config.telegram.chatId!,
      )
    )
      return;
    if (!isAllowedTelegramUser(callback.from, this.config.telegram.chatId!))
      return;
    const data = callback.data ?? "";
    try {
      if (data.startsWith("open:")) {
        const signalId = Number(data.slice(5));
        const signal = (
          await this.db.select().from(signals).where(eq(signals.id, signalId))
        )[0];
        if (!signal) throw new Error("Signal no longer exists");
        const service = this.openTradeService();
        // One-click open: the preview is created and immediately confirmed.
        // There is no operator confirmation step anymore (see the commented
        // "confirm:" branch below for the old two-step flow).
        const preview = await service.createPreview({
          signalId,
          symbol: this.config.btcSymbol,
          marketType: this.config.marketType,
          exchanges: [
            signal.longExchange as BotConfig["exchangeA"],
            signal.shortExchange as BotConfig["exchangeA"],
          ],
        });
        const messageId = callback.message?.message_id;
        if (typeof messageId === "number") {
          await this.editMessageText(
            messageId,
            `⏳ Opening trade ${preview.token.slice(0, 8)}...\n` +
              "Executing limit entry + hedge + TP/SL. " +
              `This can take up to ~${Math.round(this.config.openTrade.limitTimeoutMs / 1000)}s.`,
          ).catch((error: unknown) => {
            console.warn("Telegram opening edit failed", {
              messageId,
              message: error instanceof Error ? error.message : String(error),
            });
          });
        }
        let confirmOutcome;
        try {
          confirmOutcome = await service.confirm(preview.token);
        } catch (confirmError) {
          const confirmMessage =
            confirmError instanceof Error
              ? confirmError.message
              : "Trade execution failed";
          if (typeof messageId === "number") {
            await this.editMessageText(
              messageId,
              `❌ Trade failed: ${confirmMessage}`,
            ).catch((error: unknown) => {
              console.warn("Telegram failure edit failed", {
                messageId,
                message: error instanceof Error ? error.message : String(error),
              });
            });
          }
          throw confirmError;
        }
        await this.reportTradeOutcome(preview.token, messageId, confirmOutcome);
      } else if (data.startsWith("confirm:")) {
        /*
         * CONFIRMATION STEP DISABLED (requested 2026-09-16): trades now open
         * directly from the "Open Trade" button — the preview created in the
         * "open:" branch is confirmed immediately, and the outcome is
         * reported by reportTradeOutcome(). This branch is kept commented
         * for an easy revert to the two-step flow. Note: Confirm buttons on
         * messages sent before this change become no-ops.
         *
        const token = data.slice(8);
        const messageId = callback.message?.message_id;
        if (typeof messageId === "number") {
          await this.editMessageText(
            messageId,
            `⏳ Confirming trade ${token.slice(0, 8)}...\n` +
              "Executing limit entry + hedge + TP/SL. " +
              `This can take up to ~${Math.round(this.config.openTrade.limitTimeoutMs / 1000)}s.`,
          ).catch((error: unknown) => {
            console.warn("Telegram confirming edit failed", {
              messageId,
              message: error instanceof Error ? error.message : String(error),
            });
          });
        }
        let confirmOutcome;
        try {
          confirmOutcome = await this.openTradeService().confirm(token);
        } catch (confirmError) {
          const confirmMessage =
            confirmError instanceof Error
              ? confirmError.message
              : "Trade execution failed";
          if (typeof messageId === "number") {
            await this.editMessageText(
              messageId,
              `❌ Trade failed: ${confirmMessage}`,
            ).catch((error: unknown) => {
              console.warn("Telegram failure edit failed", {
                messageId,
                message: error instanceof Error ? error.message : String(error),
              });
            });
          }
          throw confirmError;
        }
        await this.reportTradeOutcome(token, messageId, confirmOutcome);
        */
      } else if (data.startsWith("cancel:")) {
        /*
         * CANCEL STEP DISABLED together with the confirmation preview: there
         * is no preview message with Confirm/Cancel buttons anymore, so
         * there is nothing to cancel at this point. Kept commented for an
         * easy revert together with the "confirm:" branch above.
         *
        const token = data.slice(7);
        await new DbPreviewStore(this.db).transition(token, "cancelled");
        if (typeof callback.message?.message_id === "number")
          await this.deleteMessage(callback.message.message_id);
        */
      } else if (data.startsWith("retrade:")) {
        const token = data.slice(8);
        const row = (
          await this.db
            .select()
            .from(tradePreviews)
            .where(eq(tradePreviews.token, token))
        )[0];
        if (!row || row.status !== "cancelled")
          throw new Error("Trade not available for retry");
        // SAFETY: the payload JSON column was written by createPreview()
        // from a verified OpenTradePreview object; shape is invariant.
        const preview = row.payload as unknown as OpenTradePreview;
        const retryOutcome = await this.openTradeService().retryEntry(preview);
        if (retryOutcome?.outcome === "opened") {
          // The retried limit entry filled; report the open exactly like a
          // first-attempt confirm would.
          await this.sendMessage(await this.buildFillSummary(token));
        } else if (retryOutcome?.outcome === "edge_closed") {
          await this.sendMessage(this.formatEdgeClosedNotice(retryOutcome));
        } else if (retryOutcome?.outcome === "cancelled") {
          // The repeated timeout prompt (with a fresh retry button) was
          // already sent by notifyLimitTimeout; nothing else to report.
        } else {
          await this.sendMessage(
            `❌ Retry ${token.slice(0, 8)} terminó sin un resultado ` +
              `definido. Revisá los logs antes de asumir que abrió.`,
          );
        }
      }
      await this.answerCallback(callback.id);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Trade action failed";
      console.error("Telegram callback failed", {
        callbackId: callback.id,
        data,
        message,
      });
      await this.answerCallback(
        callback.id,
        friendlyCallbackError(message, this.config.openTrade.quoteMaxAgeMs),
      );
    }
  }

  private openTradeService(): OpenTradeService {
    return new OpenTradeService(this.registry, new DbPreviewStore(this.db), {
      notionalUsd: this.config.openTrade.notionalUsd,
      leverage: this.config.leverage,
      ttlMs: this.config.openTrade.previewTtlMs,
      quoteMaxAgeMs: this.config.openTrade.quoteMaxAgeMs,
      limitTimeoutMs: this.config.openTrade.limitTimeoutMs,
      limitRepriceIntervalMs: this.config.openTrade.limitRepriceIntervalMs,
      entryImproveTicks: this.config.openTrade.entryImproveTicks,
      residualDeltaToleranceBase:
        this.config.openTrade.residualDeltaToleranceBase,
      takeProfitPercent: this.config.openTrade.takeProfitPercent,
      stopLossPercent: this.config.openTrade.stopLossPercent,
      minProfitUsd: this.config.openTrade.minProfitUsd,
      maxLossUsd: this.config.openTrade.maxLossUsd,
      slippageBps: this.config.openTrade.slippageBps,
      notifyUrgent: (text) => this.sendMessage(text),
      notifyLimitTimeout: async ({ token, message }) => {
        await this.sendMessage(message, {
          inline_keyboard: [
            [
              {
                text: "Reintentar orden limit",
                callback_data: `retrade:${token}`,
              },
            ],
          ],
        });
      },
      fees: {
        risex: {
          makerBps: this.config.openTrade.risexMakerFeeBps,
          takerBps: this.config.openTrade.risexTakerFeeBps,
        },
        extended: {
          makerBps: this.config.openTrade.extendedMakerFeeBps,
          takerBps: this.config.openTrade.extendedTakerFeeBps,
        },
        arcus: { makerBps: "0", takerBps: "0" },
        variational: {
          makerBps: this.config.openTrade.variationalMakerFeeBps,
          takerBps: this.config.openTrade.variationalTakerFeeBps,
        },
      },
    });
  }

  private async answerCallback(id: string, text?: string): Promise<void> {
    await this.fetchImpl(
      `https://api.telegram.org/bot${this.config.telegram.botToken}/answerCallbackQuery`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          callback_query_id: id,
          ...(text ? { text, show_alert: true } : {}),
        }),
      },
    );
  }
  private async deleteMessage(messageId: number): Promise<void> {
    const response = await this.fetchImpl(
      `https://api.telegram.org/bot${this.config.telegram.botToken}/deleteMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: normalizeTelegramChatId(this.config.telegram.chatId!),
          message_id: messageId,
        }),
      },
    );
    if (!response.ok)
      throw new Error(
        `Telegram deleteMessage failed with HTTP ${response.status}`,
      );
  }
  private async editMessageText(
    messageId: number,
    text: string,
  ): Promise<void> {
    const response = await this.fetchImpl(
      `https://api.telegram.org/bot${this.config.telegram.botToken}/editMessageText`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: normalizeTelegramChatId(this.config.telegram.chatId!),
          message_id: messageId,
          text,
          disable_web_page_preview: true,
        }),
      },
    );
    if (!response.ok)
      throw new Error(
        `Telegram editMessageText failed with HTTP ${response.status}`,
      );
  }
  private async reportTradeOutcome(
    token: string,
    messageId: number | undefined,
    confirmOutcome: ConfirmOutcome | undefined,
  ): Promise<void> {
    if (confirmOutcome?.outcome === "edge_closed") {
      // Both fills completed but the captured spread no longer covered
      // exit cost + minimum profit; the legs were closed at market.
      if (typeof messageId === "number") {
        await this.editMessageText(
          messageId,
          this.formatEdgeClosedNotice(confirmOutcome),
        ).catch((error: unknown) => {
          console.warn("Telegram edge-close edit failed", {
            messageId,
            message: error instanceof Error ? error.message : String(error),
          });
        });
      }
    } else if (confirmOutcome?.outcome === "cancelled") {
      // The passive limit entry never filled and the trade was
      // cancelled without opening any position. The retry prompt with
      // the "Reintentar orden limit" button was already sent by
      // notifyLimitTimeout; reflect the real state on the trigger
      // message instead of reporting a successful open.
      if (typeof messageId === "number") {
        await this.editMessageText(
          messageId,
          `⏱ Trade no abierto (${token.slice(0, 8)}): la orden ` +
            `límite expiró sin fill y el trade quedó cancelado. ` +
            `Usá "Reintentar orden limit" para intentarlo de nuevo.`,
        ).catch((error: unknown) => {
          console.warn("Telegram cancel-timeout edit failed", {
            messageId,
            message: error instanceof Error ? error.message : String(error),
          });
        });
      }
    } else if (confirmOutcome?.outcome === "opened") {
      const fillSummary = await this.buildFillSummary(token);
      if (typeof messageId === "number") {
        await this.deleteMessage(messageId).catch((error: unknown) => {
          console.warn("Telegram confirm message delete failed", {
            messageId,
            message: error instanceof Error ? error.message : String(error),
          });
        });
      }
      await this.sendMessage(fillSummary);
    } else if (typeof messageId === "number") {
      // confirm() resolved without an outcome; never report success
      // without an explicit opened result.
      await this.editMessageText(
        messageId,
        `❌ Trade ${token.slice(0, 8)} terminó sin un resultado ` +
          `definido. Revisá los logs antes de asumir que abrió.`,
      ).catch((error: unknown) => {
        console.warn("Telegram unknown-outcome edit failed", {
          messageId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  private formatEdgeClosedNotice(confirmOutcome: {
    realizedPnlUsd: string | null;
    capturedSpreadUsd: number;
    minEdgeUsd: number;
  }): string {
    const pnlText =
      confirmOutcome.realizedPnlUsd == null
        ? "n/a"
        : `$${Number(confirmOutcome.realizedPnlUsd).toFixed(2)}`;
    return (
      `⚖️ Edge insuficiente al llenar: spread capturado ` +
      `$${confirmOutcome.capturedSpreadUsd.toFixed(2)} vs mínimo ` +
      `$${confirmOutcome.minEdgeUsd.toFixed(2)}. Ambas patas ` +
      `cerradas al momento. PnL realizado: ${pnlText}.`
    );
  }

  private async buildFillSummary(token: string): Promise<string> {
    const previewRow = (
      await this.db
        .select({ tradeId: tradePreviews.tradeId })
        .from(tradePreviews)
        .where(eq(tradePreviews.token, token))
    )[0];
    if (!previewRow?.tradeId) return "✅ Trade execution completed.";
    const legs = await this.db
      .select()
      .from(tradeLegs)
      .where(eq(tradeLegs.tradeId, previewRow.tradeId));
    const longLeg = legs.find((leg) => leg.side === "long");
    const shortLeg = legs.find((leg) => leg.side === "short");
    const lines = [`✅ Trade opened (${token.slice(0, 8)})`];
    if (longLeg)
      lines.push(
        `Long: ${longLeg.exchangeId} @ $${longLeg.entryPriceUsd ?? "?"} ${longLeg.status}`,
      );
    if (shortLeg)
      lines.push(
        `Short: ${shortLeg.exchangeId} @ $${shortLeg.entryPriceUsd ?? "?"} ${shortLeg.status}`,
      );
    if (legs[0]) lines.push(`Quantity: ${legs[0].quantityBase} BTC`);
    // Farmed volume surfaced from the persisted filled_notional_usd
    // columns (design D6 / volume-farming spec), not a live-price estimate.
    const farmedVolumeUsd = legs.reduce(
      (sum, leg) => sum + parseDecimal(leg.filledNotionalUsd ?? "0"),
      0,
    );
    lines.push(`Farmed volume: $${farmedVolumeUsd.toFixed(2)}`);
    lines.push("TP/SL placed on both legs.");
    return lines.join("\n");
  }
  private async sendMessage(
    text: string,
    replyMarkup?: unknown,
  ): Promise<void> {
    for (const chunk of splitTelegramMessage(text)) {
      const response = await this.fetchImpl(
        `https://api.telegram.org/bot${this.config.telegram.botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: normalizeTelegramChatId(this.config.telegram.chatId!),
            text: chunk,
            disable_web_page_preview: true,
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
          }),
        },
      );

      if (!response.ok) {
        throw new Error(
          `Telegram sendMessage failed with HTTP ${response.status}`,
        );
      }
    }
  }
}

export function formatActiveConfigSummary(config: BotConfig): string {
  return [
    "⚙️ Active bot configuration",
    "",
    `Symbol: ${config.btcSymbol}`,
    `Market: ${config.marketType}`,
    `Price source: ${config.priceSource}`,
    `Poll interval: ${config.pricePollIntervalMs} ms`,
    `Min spread: $${formatUsd(config.minPriceDiffUsd)}`,
    `Leverage: ${config.leverage}x`,
    `Mode: ${config.botExecutionMode}`,
    `Order placement: ${config.enableOrderPlacement ? "enabled" : "disabled"}`,
    `Open trade TP/SL (venue backstop): +${config.openTrade.takeProfitPercent}% / -${config.openTrade.stopLossPercent}%`,
    `Time-stop: close open trades after ${config.openTrade.openTradeCloseTimeoutMinutes}m`,
    `Edge band: keep trade if convergence ≥ exit cost + $${formatUsd(config.openTrade.minProfitUsd)}`,
    `Edge abort max loss: $${formatUsd(config.openTrade.maxLossUsd)}`,
    `Exit slippage: ${config.openTrade.slippageBps} bps`,
    `Telegram cooldown: ${config.telegram.alertCooldownMs} ms`,
    "",
    formatExchangeLine("Exchange A", config.exchangeA, config),
    formatExchangeLine("Exchange B", config.exchangeB, config),
  ].join("\n");
}

function isTelegramCommand(text: string, command: string): boolean {
  const firstToken = text.split(/\s+/, 1)[0]?.toLowerCase();
  return (
    firstToken === `/${command}` ||
    firstToken?.startsWith(`/${command}@`) === true
  );
}

function formatExchangeLine(
  label: string,
  exchangeId: BotConfig["exchangeA"],
  config: BotConfig,
): string {
  const exchange = config[exchangeId];
  return `${label}: ${exchangeId} (${exchange.apiBaseUrl}, trading ${exchange.tradingEnabled ? "enabled" : "disabled"})`;
}

function formatUsd(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return parsed.toFixed(2);
}

/**
 * Maps raw technical error messages from the trade/callback flow to a clear,
 * operator-facing toast for the Telegram callback answer. The full technical
 * detail is always kept in the console.error log.
 */
function friendlyCallbackError(raw: string, quoteMaxAgeMs: number): string {
  switch (raw) {
    case "Executable BBO quote is stale":
      return (
        `⏱ Cotización vencida: el precio llegó con más de ${Math.round(quoteMaxAgeMs / 1000)}s de antigüedad. ` +
        'Tocá "Open Trade" de nuevo.'
      );
    case "Preview expired; open a new trade from a fresh signal":
      return '⌛ La preview de la señal expiró. Esperá una señal nueva y tocá "Open Trade" ahí.';
    case "Preview was already consumed, cancelled or expired":
      return "↪️ Esa acción ya fue usada o expiró. Si el trade no abrió, usá una señal nueva.";
    case "Signal no longer exists":
      return "🔍 La señal ya no existe (puede haber sido limpiada). Esperá la próxima señal.";
    case "Trade not available for retry":
      return "🔁 Ese trade no está disponible para reintento.";
    default:
      return `❌ No se pudo completar: ${raw}`;
  }
}

function splitTelegramMessage(text: string, maxChunkLength = 3900): string[] {
  if (text.length <= maxChunkLength) return [text];

  const paragraphs = text.split("\n\n");
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxChunkLength) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    if (paragraph.length <= maxChunkLength) {
      current = paragraph;
      continue;
    }

    for (let index = 0; index < paragraph.length; index += maxChunkLength) {
      chunks.push(paragraph.slice(index, index + maxChunkLength));
    }
  }

  if (current) chunks.push(current);
  return chunks;
}
