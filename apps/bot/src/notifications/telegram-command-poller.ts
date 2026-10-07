import type { BotConfig } from "@btc-arbitrage/config";
import type { getDb } from "@btc-arbitrage/db";
import { signals, tradePreviews } from "@btc-arbitrage/db";
import { eq } from "drizzle-orm";
import {
  buildTradeSummaryMessage,
  type ExchangeRegistryLike,
} from "./trade-summary.js";
import { buildLastSignalsMessage } from "./last-signals-summary.js";
import {
  buildTradeOpenedSummary,
  formatEdgeClosedNotice,
} from "../trading/opened-trade-summary.js";
import {
  lastSixMonthsFrom,
  loadMonthlyNetPnlBreakdown,
  loadMonthlyVolumeBreakdown,
  loadNetPnlTotals,
  loadVolumeTotals,
  previousMonthRange,
  type NetPnlTotals,
  type VolumeTotals,
} from "../trading/volume-stats.js";
import { formatPnlColored } from "../trading/trade-close.js";
import {
  isAllowedTelegramChat,
  isAllowedTelegramUser,
  normalizeTelegramChatId,
  type FetchLike,
} from "./telegram-notifier.js";
import type { ExecutionQueue } from "../trading/execution-queue.js";
import { createOpenTradeService } from "../trading/open-trade-factory.js";
import {
  applyAutoConfirm,
  applyCooldownMinutes,
  applyMarginUsd,
  applyMinSpreadUsd,
  isRuntimeSettingOverridden,
  snapshotRuntimeSettings,
  type RuntimeSettingChange,
  type RuntimeSettingsBaseline,
} from "../runtime/runtime-settings.js";

// 2026-09-28: a hung Telegram request froze the bot's polling loop forever
// (no timeout anywhere in the bot). Every outbound call now aborts after
// 10 s so the loop's per-tick catch can recover.
const TELEGRAM_REQUEST_TIMEOUT_MS = 10_000;
import type {
  OpenTradeService,
  ConfirmOutcome,
  OpenTradePreview,
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
  {
    command: "volume",
    description: "Volumen generado (farmed): total, mes anterior, 6 meses",
  },
  {
    command: "lastsignal",
    description: "Últimas 10 señales (hora local)",
  },
] as const;

export class TelegramCommandPoller {
  private offset = 0;

  private readonly settingsBaseline: RuntimeSettingsBaseline;
  private pendingSettingPrompt: "cooldown" | "spread" | "margin" | null =
    null;

  constructor(
    private readonly config: BotConfig,
    private readonly db: Awaited<ReturnType<typeof getDb>>,
    private readonly registry: ExchangeRegistryLike,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly executionQueue: ExecutionQueue,
  ) {
    this.settingsBaseline = snapshotRuntimeSettings(config);
  }

  async configureAvailableCommands(): Promise<void> {
    if (!this.config.telegram.enabled) return;
    if (!this.config.telegram.botToken || !this.config.telegram.chatId) return;

    const response = await this.fetchWithTimeout(
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

    const response = await this.fetchWithTimeout(url.toString());
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
      if (this.pendingSettingPrompt) {
        if (!text.startsWith("/")) {
          await this.handleSettingValueInput(text, update.update_id);
          return;
        }
        // A fresh command cancels the pending setting prompt.
        this.pendingSettingPrompt = null;
      }

      if (isTelegramCommand(text, "config")) {
        await this.sendMessage(
          formatActiveConfigSummary(this.config, this.settingsBaseline),
          { inline_keyboard: RUNTIME_SETTING_BUTTONS },
        );
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

      if (isTelegramCommand(text, "volume")) {
        await this.sendMessage(await buildVolumeMessage(this.db, "total"), {
          inline_keyboard: [VOLUME_VIEW_BUTTONS],
        });
        return;
      }

      if (isTelegramCommand(text, "lastsignal")) {
        await this.sendMessage(
          await buildLastSignalsMessage(
            this.db,
            this.config.telegram.operatorTimezone,
          ),
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

  private async handleSettingValueInput(
    text: string,
    updateId: number,
  ): Promise<void> {
    const kind = this.pendingSettingPrompt;
    if (!kind) return;
    try {
      const value = Number(text.replace(",", "."));
      let change: RuntimeSettingChange;
      try {
        change =
          kind === "cooldown"
            ? applyCooldownMinutes(this.config, value)
          : kind === "spread"
            ? applyMinSpreadUsd(this.config, value)
            : applyMarginUsd(this.config, value);
      } catch (validationError) {
        // Invalid value: keep the prompt open so the operator can retry.
        const message =
          validationError instanceof Error
            ? validationError.message
            : String(validationError);
        await this.sendMessage(
          `❌ ${message}\nProbá de nuevo, o tocá /config para empezar de nuevo.`,
        );
        return;
      }
      this.pendingSettingPrompt = null;
      console.warn("Runtime setting updated", { updateId, kind, ...change });
      await this.sendMessage(`✅ ${change.summary}`);
    } catch (error) {
      console.error("Telegram setting input failed", {
        updateId,
        kind,
        message: error instanceof Error ? error.message : String(error),
      });
      this.pendingSettingPrompt = null;
      await this.sendMessage(
        "❌ No se pudo actualizar el ajuste. Reintentá, o tocá /config para empezar de nuevo.",
      );
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
      if (data === "set:cancel") {
        this.pendingSettingPrompt = null;
        const messageId = callback.message?.message_id;
        if (typeof messageId === "number") {
          await this.editMessageText(messageId, "Cancelado.").catch(
            (error: unknown) => {
              console.warn("Telegram setting-cancel edit failed", {
                messageId,
                message:
                  error instanceof Error ? error.message : String(error),
              });
            },
          );
        }
      } else if (data === "set:cooldown") {
        const messageId = callback.message?.message_id;
        if (typeof messageId === "number") {
          await this.editMessageText(
            messageId,
            "Elegí el cooldown de alertas:",
            {
              inline_keyboard: [
                [
                  { text: "5 min", callback_data: "cd:5" },
                  { text: "30 min", callback_data: "cd:30" },
                  { text: "60 min", callback_data: "cd:60" },
                ],
                [
                  { text: "Custom…", callback_data: "cd:custom" },
                  { text: "Cancelar", callback_data: "set:cancel" },
                ],
              ],
            },
          ).catch((error: unknown) => {
            console.warn("Telegram cooldown-menu edit failed", {
              messageId,
              message: error instanceof Error ? error.message : String(error),
            });
          });
        }
      } else if (data.startsWith("cd:")) {
        const option = data.slice(3);
        const messageId = callback.message?.message_id;
        if (option === "custom") {
          this.pendingSettingPrompt = "cooldown";
          if (typeof messageId === "number") {
            await this.editMessageText(
              messageId,
              "Mandame el cooldown en minutos (número entre 1 y 10080).",
              SETTING_CANCEL_MARKUP,
            ).catch((error: unknown) => {
              console.warn("Telegram cooldown-custom edit failed", {
                messageId,
                message:
                  error instanceof Error ? error.message : String(error),
              });
            });
          }
        } else {
          try {
            const change = applyCooldownMinutes(
              this.config,
              Number(option),
            );
            this.pendingSettingPrompt = null;
            if (typeof messageId === "number") {
              await this.editMessageText(
                messageId,
                `✅ ${change.summary}`,
              ).catch((error: unknown) => {
                console.warn("Telegram cooldown-apply edit failed", {
                  messageId,
                  message:
                    error instanceof Error ? error.message : String(error),
                });
              });
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            if (typeof messageId === "number") {
              await this.editMessageText(messageId, `❌ ${message}`).catch(
                (error: unknown) => {
                  console.warn("Telegram cooldown-error edit failed", {
                    messageId,
                    message:
                      error instanceof Error ? error.message : String(error),
                  });
                },
              );
            }
          }
        }
      } else if (data === "set:spread") {
        this.pendingSettingPrompt = "spread";
        const messageId = callback.message?.message_id;
        if (typeof messageId === "number") {
          await this.editMessageText(
            messageId,
            "Mandame el nuevo min spread en USD (ej: 40).",
            SETTING_CANCEL_MARKUP,
          ).catch((error: unknown) => {
            console.warn("Telegram spread-prompt edit failed", {
              messageId,
              message: error instanceof Error ? error.message : String(error),
            });
          });
        }
      } else if (data === "set:margin") {
        this.pendingSettingPrompt = "margin";
        const messageId = callback.message?.message_id;
        if (typeof messageId === "number") {
          await this.editMessageText(
            messageId,
            `Mandame el nuevo margin por pata en USD (ej: 20). El notional se recalcula como margin × leverage (${this.config.leverage}x).`,
            SETTING_CANCEL_MARKUP,
          ).catch((error: unknown) => {
            console.warn("Telegram margin-prompt edit failed", {
              messageId,
              message: error instanceof Error ? error.message : String(error),
            });
          });
        }
      } else if (data === "set:autoconfirm") {
        // Two-step confirmation: this toggle turns the bot into an
        // auto-trader (or back), so the first tap only shows a warning
        // prompt and a second tap on the explicit action applies it.
        const enabled = this.config.openTrade.autoConfirm;
        const messageId = callback.message?.message_id;
        if (typeof messageId === "number") {
          await this.editMessageText(
            messageId,
            enabled
              ? "🤖 Auto-confirm está ACTIVADO: el bot abre trades solo apenas " +
                "aparece una señal, sin confirmación por Telegram.\n\n" +
                "¿Está seguro que desea DESACTIVARLO? El bot volverá a esperar " +
                "tu confirmación manual en cada señal."
              : "🤖 AUTO-TRADING: si activás auto-confirm, el bot abrirá trades " +
                "automáticamente apenas aparezca una señal, SIN confirmación " +
                "por Telegram. Los entry guards siguen aplicando.\n\n" +
                "¿Está seguro que desea realizar esta acción?",
            {
              inline_keyboard: [
                [
                  {
                    text: enabled ? "✅ Sí, desactivar" : "✅ Sí, activar",
                    callback_data: enabled ? "ac:off" : "ac:on",
                  },
                  { text: "❌ Cancelar", callback_data: "set:cancel" },
                ],
              ],
            },
          ).catch((error: unknown) => {
            console.warn("Telegram auto-confirm prompt edit failed", {
              messageId,
              message: error instanceof Error ? error.message : String(error),
            });
          });
        }
      } else if (data === "ac:on" || data === "ac:off") {
        const messageId = callback.message?.message_id;
        try {
          const change = applyAutoConfirm(this.config, data === "ac:on");
          if (typeof messageId === "number") {
            await this.editMessageText(messageId, `✅ ${change.summary}`).catch(
              (error: unknown) => {
                console.warn("Telegram auto-confirm-apply edit failed", {
                  messageId,
                  message:
                    error instanceof Error ? error.message : String(error),
                });
              },
            );
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (typeof messageId === "number") {
            await this.editMessageText(messageId, `❌ ${message}`).catch(
              (error: unknown) => {
                console.warn("Telegram auto-confirm-error edit failed", {
                  messageId,
                  message:
                    error instanceof Error ? error.message : String(error),
                });
              },
            );
          }
        }
      } else if (data.startsWith("open:")) {
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
        // Decoupled from the polling tick: the confirm (limit entry fill
        // wait + hedge + TP/SL, 30–45 s typical) runs on the shared
        // serial execution queue so price polling and monitoring keep
        // ticking. Synchronous preview errors above still reach the
        // callback catch below for the friendly toast.
        this.executionQueue.enqueue({
          description: `open-trade:${preview.token.slice(0, 8)}`,
          run: async () => {
            try {
              const confirmOutcome = await service.confirm(preview.token);
              await this.reportTradeOutcome(
                preview.token,
                messageId,
                confirmOutcome,
              );
            } catch (confirmError) {
              const confirmMessage =
                confirmError instanceof Error
                  ? confirmError.message
                  : "Trade execution failed";
              console.error("Open trade job failed", {
                token: preview.token.slice(0, 8),
                message: confirmMessage,
              });
              if (typeof messageId === "number") {
                await this.editMessageText(
                  messageId,
                  `❌ Trade failed: ${confirmMessage}`,
                ).catch((error: unknown) => {
                  console.warn("Telegram failure edit failed", {
                    messageId,
                    message:
                      error instanceof Error ? error.message : String(error),
                  });
                });
              }
            }
          },
        });
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
        // Retry execution is decoupled from the polling tick onto the
        // shared serial queue, exactly like the open: branch above.
        this.executionQueue.enqueue({
          description: `retrade:${token.slice(0, 8)}`,
          run: async () => {
            try {
              const retryOutcome =
                await this.openTradeService().retryEntry(preview);
              if (retryOutcome?.outcome === "opened") {
                // The retried limit entry filled; report the open exactly
                // like a first-attempt confirm would.
                await this.sendMessage(await this.buildFillSummary(token));
              } else if (retryOutcome?.outcome === "edge_closed") {
                await this.sendMessage(formatEdgeClosedNotice(retryOutcome));
              } else if (retryOutcome?.outcome === "cancelled") {
                // The repeated timeout prompt (with a fresh retry button)
                // was already sent by notifyLimitTimeout; nothing else to
                // report.
              } else {
                await this.sendMessage(
                  `❌ Retry ${token.slice(0, 8)} terminó sin un resultado ` +
                    `definido. Revisá los logs antes de asumir que abrió.`,
                );
              }
            } catch (retryError) {
              const retryMessage =
                retryError instanceof Error
                  ? retryError.message
                  : "Trade execution failed";
              console.error("Retrade job failed", {
                token: token.slice(0, 8),
                message: retryMessage,
              });
              // The retry trigger message may already carry the timeout
              // prompt, so the failure notice goes out as a fresh message
              // to the operator instead of an edit.
              await this.sendMessage(`❌ Retry failed: ${retryMessage}`);
            }
          },
        });
      } else if (data.startsWith("volume:")) {
        const view = data.slice("volume:".length);
        if (view === "total" || view === "prevmonth" || view === "6m") {
          const messageId = callback.message?.message_id;
          if (typeof messageId === "number") {
            await this.editMessageText(
              messageId,
              await buildVolumeMessage(this.db, view),
              { inline_keyboard: [VOLUME_VIEW_BUTTONS] },
            );
          }
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
    return createOpenTradeService({
      config: this.config,
      registry: this.registry,
      db: this.db,
      notify: {
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
      },
    });
  }

  private async answerCallback(id: string, text?: string): Promise<void> {
    await this.fetchWithTimeout(
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
  private fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
    return this.fetchImpl(url, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS),
    });
  }

  private async deleteMessage(messageId: number): Promise<void> {
    const response = await this.fetchWithTimeout(
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
    replyMarkup?: unknown,
  ): Promise<void> {
    const response = await this.fetchWithTimeout(
      `https://api.telegram.org/bot${this.config.telegram.botToken}/editMessageText`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: normalizeTelegramChatId(this.config.telegram.chatId!),
          message_id: messageId,
          text,
          disable_web_page_preview: true,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
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
          formatEdgeClosedNotice(confirmOutcome),
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

  private async buildFillSummary(token: string): Promise<string> {
    return buildTradeOpenedSummary(this.db, token);
  }
  private async sendMessage(
    text: string,
    replyMarkup?: unknown,
  ): Promise<void> {
    for (const chunk of splitTelegramMessage(text)) {
      const response = await this.fetchWithTimeout(
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

type VolumeView = "total" | "prevmonth" | "6m";

const VOLUME_VIEW_BUTTONS = [
  { text: "Total", callback_data: "volume:total" },
  { text: "Mes anterior", callback_data: "volume:prevmonth" },
  { text: "6 meses", callback_data: "volume:6m" },
] as const;

// Two rows: the dangerous auto-trading toggle sits alone below the
// everyday settings so it never renders glued to them.
const RUNTIME_SETTING_BUTTONS = [
  [
    { text: "⏱ Cooldown", callback_data: "set:cooldown" },
    { text: "📏 Min spread", callback_data: "set:spread" },
    { text: "💰 Margin", callback_data: "set:margin" },
  ],
  [{ text: "🤖 Auto trade", callback_data: "set:autoconfirm" }],
] as const;

const SETTING_CANCEL_MARKUP = {
  inline_keyboard: [[{ text: "Cancelar", callback_data: "set:cancel" }]],
};

const VOLUME_ATTRIBUTION_NOTE = "(atribuido por apertura del trade, UTC)";

/** Two-line net-PnL block shown after the volume total in every /volume
 * view. The label is load-bearing: only fees persisted since the
 * fee-capture feature landed are summed (historical fees under-report),
 * and funding is out of scope. */
function formatNetPnlLines(net: NetPnlTotals): string[] {
  return [
    `PnL realizado: $${net.realizedUsd.toFixed(2)} · Fees: $${net.feesUsd.toFixed(2)}`,
    `Neto: ${formatPnlColored(net.netUsd)} (trading fees conocidos, sin funding)`,
  ];
}

/** Compact signed USD (no emoji) for inline per-month net suffixes. */
function formatSignedUsd(value: number): string {
  return value >= 0
    ? `+$${value.toFixed(2)}`
    : `-$${Math.abs(value).toFixed(2)}`;
}

function formatExchangeVolumeLines(
  byExchange: VolumeTotals["byExchange"],
): string[] {
  if (byExchange.length === 0) return [];
  return [
    "Por exchange:",
    ...byExchange.map(
      (entry) => `  ${entry.exchangeId}: $${entry.usd.toFixed(2)}`,
    ),
  ];
}

/** Renders one of the /volume views. Farmed volume = the filled_notional_usd
 * increments (design D6); monthly views attribute volume to the trade's
 * opening month. Every view also shows the net-PnL block (realized minus
 * known trading fees; funding excluded, historical fees under-report). */
async function buildVolumeMessage(
  db: Awaited<ReturnType<typeof getDb>>,
  view: VolumeView,
): Promise<string> {
  if (view === "prevmonth") {
    const range = previousMonthRange();
    const stats = await loadVolumeTotals(db, range);
    const net = await loadNetPnlTotals(db, range);
    return [
      `📊 Volumen generado — ${range.label}`,
      `Total: $${stats.totalUsd.toFixed(2)}`,
      ...formatNetPnlLines(net),
      ...formatExchangeVolumeLines(stats.byExchange),
      VOLUME_ATTRIBUTION_NOTE,
    ].join("\n");
  }
  if (view === "6m") {
    const from = lastSixMonthsFrom();
    const months = await loadMonthlyVolumeBreakdown(db, from);
    const netMonths = await loadMonthlyNetPnlBreakdown(db, from);
    const stats = await loadVolumeTotals(db, { from });
    const net = await loadNetPnlTotals(db, { from });
    const byMonth = new Map(months.map((row) => [row.month, row.usd]));
    const netByMonth = new Map(
      netMonths.map((row) => [row.month, row.netUsd]),
    );
    // Zero-fill the whole window so every calendar month shows a line,
    // including months with no trades.
    const monthLines: string[] = [];
    const cursor = new Date(from.getTime());
    const now = new Date();
    while (
      cursor.getUTCFullYear() < now.getUTCFullYear() ||
      (cursor.getUTCFullYear() === now.getUTCFullYear() &&
        cursor.getUTCMonth() <= now.getUTCMonth())
    ) {
      const label = `${cursor.getUTCFullYear()}-${String(
        cursor.getUTCMonth() + 1,
      ).padStart(2, "0")}`;
      const suffix =
        label ===
        `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`
          ? " (en curso)"
          : "";
      // Months with no realized PnL have no net row: no suffix, rather
      // than a misleading "+0.00".
      const netSuffix = netByMonth.has(label)
        ? ` · neto ${formatSignedUsd(netByMonth.get(label) ?? 0)}`
        : "";
      monthLines.push(
        `${label}: $${(byMonth.get(label) ?? 0).toFixed(2)}${suffix}${netSuffix}`,
      );
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    return [
      "📊 Volumen generado — últimos 6 meses",
      ...monthLines,
      `Total período: $${stats.totalUsd.toFixed(2)}`,
      ...formatNetPnlLines(net),
      ...formatExchangeVolumeLines(stats.byExchange),
      VOLUME_ATTRIBUTION_NOTE,
    ].join("\n");
  }
  const stats = await loadVolumeTotals(db);
  const net = await loadNetPnlTotals(db);
  return [
    "📊 Volumen generado (farmed)",
    `Total histórico: $${stats.totalUsd.toFixed(2)}`,
    ...formatNetPnlLines(net),
    ...formatExchangeVolumeLines(stats.byExchange),
    VOLUME_ATTRIBUTION_NOTE,
  ].join("\n");
}

export function formatActiveConfigSummary(
  config: BotConfig,
  baseline?: RuntimeSettingsBaseline,
): string {
  const minSpreadOverridden =
    baseline != null &&
    isRuntimeSettingOverridden("minSpreadUsd", baseline, config);
  const marginOverridden =
    baseline != null &&
    isRuntimeSettingOverridden("marginUsd", baseline, config);
  const cooldownOverridden =
    baseline != null &&
    isRuntimeSettingOverridden("cooldownMinutes", baseline, config);
  const autoConfirmOverridden =
    baseline != null &&
    isRuntimeSettingOverridden("autoConfirm", baseline, config);
  const lines = [
    "⚙️ Active bot configuration",
    "",
    `Symbol: ${config.btcSymbol}`,
    `Market: ${config.marketType}`,
    `Price source: ${config.priceSource}`,
    `Poll interval: ${config.pricePollIntervalMs} ms`,
    `Min spread: $${formatUsd(config.minPriceDiffUsd)}${minSpreadOverridden ? " *" : ""}`,
    `Leverage: ${config.leverage}x`,
    `Mode: ${config.botExecutionMode}`,
    `Open trade margin: $${formatUsd(config.openTrade.marginUsd)} per leg (notional $${formatUsd(config.openTrade.notionalUsd)} at ${config.leverage}x)${marginOverridden ? " *" : ""}`,
    `Open trade TP/SL: TP: ${config.openTrade.takeProfitPercent}% / SL: -${config.openTrade.stopLossPercent}%`,
    `Auto-confirm (auto-trading): ${config.openTrade.autoConfirm ? "ACTIVADO 🤖" : "off"}${autoConfirmOverridden ? " *" : ""}`,
    `Telegram cooldown: ${config.telegram.alertCooldownMs} ms${cooldownOverridden ? " *" : ""}`,
    "",
    formatExchangeLine("Exchange A", config.exchangeA, config),
    formatExchangeLine("Exchange B", config.exchangeB, config),
  ];
  if (
    minSpreadOverridden ||
    marginOverridden ||
    cooldownOverridden ||
    autoConfirmOverridden
  ) {
    lines.push("", "(* ajustado en caliente — no persiste al reiniciar)");
  }
  return lines.join("\n");
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
