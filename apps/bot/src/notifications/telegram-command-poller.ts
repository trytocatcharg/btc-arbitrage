import type { BotConfig } from "@btc-arbitrage/config";
import type { getDb } from "@btc-arbitrage/db";
import { signals, tradePreviews } from "@btc-arbitrage/db";
import { eq } from "drizzle-orm";
import { findTradingPair, TRADING_PAIRS } from "@btc-arbitrage/domain";
import {
  buildLastTradesMessage,
  buildTradeSummaryMessage,
  hasActiveTrades,
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
  loadNetPnlTotals,
  previousMonthRange,
  type NetPnlTotals,
} from "../trading/volume-stats.js";
import {
  loadAvailableBalances,
  loadExchangeVolume,
} from "../trading/exchange-volume.js";
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
  applyLeverage,
  applyMarginUsd,
  applyMinSpreadUsd,
  applyTradingPair,
  isRuntimeSettingOverridden,
  MAX_LEVERAGE,
  snapshotRuntimeSettings,
  type RuntimeSettingChange,
  type RuntimeSettingsBaseline,
} from "../runtime/runtime-settings.js";
import {
  loadActiveTrades,
  type BotControl,
} from "../runtime/runtime-control.js";
import { persistRuntimeOverride } from "../runtime/runtime-settings-store.js";

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
    command: "bot",
    description: "Pause or restart the bot",
  },
  {
    command: "config",
    description: "Show active bot configuration",
  },
  {
    command: "trade",
    description: "Trade panel: active trade + last 10 closed",
  },
  {
    command: "volume",
    description: "Volume by exchange: total, previous month, 6 months",
  },
  {
    command: "lastsignal",
    description: "Last 10 signals (local time)",
  },
] as const;

export class TelegramCommandPoller {
  private offset = 0;

  private readonly settingsBaseline: RuntimeSettingsBaseline;
  private pendingSettingPrompt:
    | "cooldown"
    | "spread"
    | "margin"
    | "leverage"
    | null = null;

  constructor(
    private readonly config: BotConfig,
    private readonly db: Awaited<ReturnType<typeof getDb>>,
    private readonly registry: ExchangeRegistryLike,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly executionQueue: ExecutionQueue,
    private readonly control?: BotControl,
    settingsBaseline?: RuntimeSettingsBaseline,
  ) {
    // Prefer the process-level env baseline when wired (main.ts), so the
    // "ajustado en caliente" markers compare against the real env values;
    // a standalone poller falls back to self-snapshotting.
    this.settingsBaseline = settingsBaseline ?? snapshotRuntimeSettings(config);
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

      if (isTelegramCommand(text, "bot")) {
        await this.sendBotControlPanel();
        return;
      }

      if (isTelegramCommand(text, "config")) {
        await this.sendMessage(
          formatActiveConfigSummary(this.config, this.settingsBaseline),
          { inline_keyboard: RUNTIME_SETTING_BUTTONS },
        );
        return;
      }

      if (isTelegramCommand(text, "trade")) {
        // Panel with buttons: each button sends a NEW message (operator
        // decision 2026-10-09), so the panel stays available in the chat.
        const hasActive = await hasActiveTrades(this.db);
        await this.sendMessage(
          hasActive
            ? "Trade panel: choose what to view."
            : "📭 No active trades right now.",
          {
            inline_keyboard: hasActive
              ? [TRADE_PANEL_BUTTONS]
              : [TRADE_HISTORY_BUTTON],
          },
        );
        return;
      }

      if (isTelegramCommand(text, "volume")) {
        await this.sendMessage(
          await buildVolumeMessage(this.db, this.registry, "total"),
          {
            inline_keyboard: [VOLUME_VIEW_BUTTONS],
          },
        );
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
      // Leverage is written to the exchanges inside
      // validateExecutionPreflight, so exchanges are prepared BEFORE the
      // config value changes; an exchange rejection keeps the current value.
      // Policy: specs/exchange-execution.md ("Startup execution preflight").
      if (kind === "leverage") {
        if (!Number.isInteger(value) || value < 1 || value > MAX_LEVERAGE) {
          await this.sendMessage(
            `❌ Leverage must be an integer between 1 and ${MAX_LEVERAGE}.\nTry again, or tap /config to start over.`,
          );
          return;
        }
        const failures: string[] = [];
        for (const exchangeId of [
          this.config.exchangeA,
          this.config.exchangeB,
        ]) {
          const adapter = this.registry.get(exchangeId);
          if (!adapter.capabilities.orderPlacement || !adapter.execution)
            continue;
          try {
            await adapter.execution.validateExecutionPreflight({
              symbol: this.config.btcSymbol,
              leverage: value,
            });
          } catch (error) {
            failures.push(
              `${exchangeId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        if (failures.length > 0) {
          this.pendingSettingPrompt = null;
          await this.sendMessage(
            "❌ Could not set the leverage on the exchange(s); leverage stays " +
              `at ${this.config.leverage}x.\n${failures.join("\n")}`,
          );
          return;
        }
      }
      let change: RuntimeSettingChange;
      try {
        change =
          kind === "cooldown"
            ? applyCooldownMinutes(this.config, value)
            : kind === "spread"
              ? applyMinSpreadUsd(this.config, value)
              : kind === "margin"
                ? applyMarginUsd(this.config, value)
                : applyLeverage(this.config, value);
      } catch (validationError) {
        // Invalid value: keep the prompt open so the operator can retry.
        const message =
          validationError instanceof Error
            ? validationError.message
            : String(validationError);
        await this.sendMessage(
          `❌ ${message}\nTry again, or tap /config to start over.`,
        );
        return;
      }
      this.pendingSettingPrompt = null;
      console.warn("Runtime setting updated", { updateId, kind, ...change });
      const persistNote = await this.persistAppliedChange(change);
      const exchangeSyncNote =
        kind === "leverage" ? "\n(exchange leverage updated)" : "";
      await this.sendMessage(
        `✅ ${change.summary}${persistNote}${exchangeSyncNote}`,
      );
    } catch (error) {
      console.error("Telegram setting input failed", {
        updateId,
        kind,
        message: error instanceof Error ? error.message : String(error),
      });
      this.pendingSettingPrompt = null;
      await this.sendMessage(
        "❌ Could not update the setting. Try again, or tap /config to start over.",
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
          await this.editMessageText(messageId, "Cancelled.").catch(
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
            "Choose the alert cooldown:",
            {
              inline_keyboard: [
                [
                  { text: "5 min", callback_data: "cd:5" },
                  { text: "30 min", callback_data: "cd:30" },
                  { text: "60 min", callback_data: "cd:60" },
                ],
                [
                  { text: "Custom…", callback_data: "cd:custom" },
                  { text: "Cancel", callback_data: "set:cancel" },
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
              "Send me the cooldown in minutes (a number between 1 and 10080).",
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
            const persistNote = await this.persistAppliedChange(change);
            if (typeof messageId === "number") {
              await this.editMessageText(
                messageId,
                `✅ ${change.summary}${persistNote}`,
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
            "Send me the new min spread in USD (e.g. 40).",
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
            `Send me the new margin per leg in USD (e.g. 20). The notional is recalculated as margin × leverage (${this.config.leverage}x).`,
            SETTING_CANCEL_MARKUP,
          ).catch((error: unknown) => {
            console.warn("Telegram margin-prompt edit failed", {
              messageId,
              message: error instanceof Error ? error.message : String(error),
            });
          });
        }
      } else if (data === "set:leverage") {
        this.pendingSettingPrompt = "leverage";
        const messageId = callback.message?.message_id;
        if (typeof messageId === "number") {
          await this.editMessageText(
            messageId,
            "Send me the new leverage (integer between 1 and 50). " +
              `The per-leg notional is recalculated as margin × leverage ` +
              `(current margin $${Number(this.config.openTrade.marginUsd).toFixed(2)}).`,
            SETTING_CANCEL_MARKUP,
          ).catch((error: unknown) => {
            console.warn("Telegram leverage-prompt edit failed", {
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
              ? "🤖 Auto-confirm is ON: the bot opens trades on its own as soon as " +
                "a signal appears, without Telegram confirmation.\n\n" +
                "Are you sure you want to DISABLE it? The bot will go back to " +
                "waiting for your manual confirmation on each signal."
              : "🤖 AUTO-TRADING: if you enable auto-confirm, the bot will open " +
                "trades automatically as soon as a signal appears, WITHOUT " +
                "Telegram confirmation. Entry guards still apply.\n\n" +
                "Are you sure you want to perform this action?",
            {
              inline_keyboard: [
                [
                  {
                    text: enabled ? "✅ Yes, disable" : "✅ Yes, enable",
                    callback_data: enabled ? "ac:off" : "ac:on",
                  },
                  { text: "❌ Cancel", callback_data: "set:cancel" },
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
          const persistNote = await this.persistAppliedChange(change);
          if (typeof messageId === "number") {
            await this.editMessageText(
              messageId,
              `✅ ${change.summary}${persistNote}`,
            ).catch((error: unknown) => {
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
      } else if (data === "set:pair") {
        const messageId = callback.message?.message_id;
        const current = findTradingPair(this.config.btcSymbol);
        if (typeof messageId === "number") {
          await this.editMessageText(
            messageId,
            "🪙 Pairs — choose the pair the strategy trades\n\n" +
              `Active: ${current?.label ?? this.config.btcSymbol} (${this.config.btcSymbol})\n\n` +
              "When you switch the pair, the bot opens and closes positions with the " +
              "new pair from the next signal. Already-open positions are not " +
              "affected.",
            buildPairsMenuMarkup(this.config.btcSymbol),
          ).catch((error: unknown) => {
            console.warn("Telegram pairs-menu edit failed", {
              messageId,
              message: error instanceof Error ? error.message : String(error),
            });
          });
        }
      } else if (data.startsWith("pair:apply:")) {
        // Confirm step of the Pairs flow. `pair:apply:` is matched BEFORE
        // the generic `pair:` prefix branch below.
        const symbol = data.slice("pair:apply:".length);
        const pair = findTradingPair(symbol);
        const messageId = callback.message?.message_id;
        if (!pair) {
          if (typeof messageId === "number") {
            await this.editMessageText(
              messageId,
              `❌ Unsupported pair: ${symbol}`,
            ).catch((error: unknown) => {
              console.warn("Telegram pair-apply-unknown edit failed", {
                messageId,
                message:
                  error instanceof Error ? error.message : String(error),
              });
            });
          }
        } else {
          try {
            // Live guard, same family as /bot control: no pair switch
            // while a trade is open or an execution is in flight.
            const [active, queueBusy] = await Promise.all([
              loadActiveTrades(this.db),
              Promise.resolve(this.executionQueue.isExecuting()),
            ]);
            if (active.length > 0 || queueBusy) {
              const refusal =
                active.length > 0
                  ? `⛔ Cannot switch pair: there are ${active.length} ` +
                    "active trade(s). Close the positions first."
                  : "⛔ Cannot switch pair: a trade execution is in progress.";
              if (typeof messageId === "number") {
                await this.editMessageText(messageId, refusal).catch(
                  (error: unknown) => {
                    console.warn("Telegram pair-apply-refusal edit failed", {
                      messageId,
                      message:
                        error instanceof Error ? error.message : String(error),
                    });
                  },
                );
              }
            } else {
              // Prepare the exchanges BEFORE applying: RISEx sets the account
              // leverage per market, so the new symbol must be preflighted
              // while the bot still operates the previous pair. Any
              // failure keeps the current pair untouched.
              const failures: string[] = [];
              for (const exchangeId of [
                this.config.exchangeA,
                this.config.exchangeB,
              ]) {
                const adapter = this.registry.get(exchangeId);
                if (!adapter.capabilities.orderPlacement || !adapter.execution)
                  continue;
                try {
                  await adapter.execution.validateExecutionPreflight({
                    symbol: pair.symbol,
                    leverage: this.config.leverage,
                  });
                } catch (error) {
                  failures.push(
                    `${exchangeId}: ${error instanceof Error ? error.message : String(error)}`,
                  );
                }
              }
              if (failures.length > 0) {
                if (typeof messageId === "number") {
                  await this.editMessageText(
                    messageId,
                    "❌ Could not prepare the new pair; staying with " +
                      `${this.config.btcSymbol}.\n${failures.join("\n")}`,
                  ).catch((error: unknown) => {
                    console.warn("Telegram pair-apply-preflight edit failed", {
                      messageId,
                      message:
                        error instanceof Error ? error.message : String(error),
                    });
                  });
                }
              } else {
                const change = applyTradingPair(this.config, pair.symbol);
                const persistNote = await this.persistAppliedChange(change);
                if (typeof messageId === "number") {
                  await this.editMessageText(
                    messageId,
                    `✅ ${change.summary}${persistNote}\n\n` +
                      `The bot trades ${pair.label} from the next signal.`,
                  ).catch((error: unknown) => {
                    console.warn("Telegram pair-apply edit failed", {
                      messageId,
                      message:
                        error instanceof Error ? error.message : String(error),
                    });
                  });
                }
              }
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            if (typeof messageId === "number") {
              await this.editMessageText(messageId, `❌ ${message}`).catch(
                (error: unknown) => {
                  console.warn("Telegram pair-apply-error edit failed", {
                    messageId,
                    message:
                      error instanceof Error ? error.message : String(error),
                  });
                },
              );
            }
          }
        }
      } else if (data.startsWith("pair:")) {
        // Pair selected: show 24h traded volume per ACTIVE exchange
        // (the monitored pair A/B via the registry) and ask for the
        // final confirmation.
        const symbol = data.slice("pair:".length);
        const pair = findTradingPair(symbol);
        const messageId = callback.message?.message_id;
        if (!pair) {
          if (typeof messageId === "number") {
            await this.editMessageText(
              messageId,
              `❌ Unsupported pair: ${symbol}`,
            ).catch((error: unknown) => {
              console.warn("Telegram pair-unknown edit failed", {
                messageId,
                message: error instanceof Error ? error.message : String(error),
              });
            });
          }
        } else {
          const volumeLines = await Promise.all(
            [
              this.config.exchangeA,
              this.config.exchangeB,
            ].map(async (exchangeId) => {
              try {
                const stats = await this.registry
                  .get(exchangeId)
                  .getMarketStats?.({
                    symbol: pair.symbol,
                    marketType: this.config.marketType,
                    priceSource: this.config.priceSource,
                  });
                const volume = stats?.volume24hUsd;
                const rendered =
                  volume && Number.isFinite(Number(volume))
                    ? `$${Number(volume).toLocaleString("en-US")}`
                    : "n/d";
                return `  ${exchangeId}: ${rendered}`;
              } catch (error) {
                return `  ${exchangeId}: error (${error instanceof Error ? error.message : String(error)})`;
              }
            }),
          );
          if (typeof messageId === "number") {
            await this.editMessageText(
              messageId,
              `🪙 ${pair.label} (${pair.symbol}) — traded volume last 24h\n\n` +
                volumeLines.join("\n") +
                `\n\nOn confirm, the bot trades ${pair.label} from the next signal.`,
              buildPairConfirmMarkup(pair.symbol),
            ).catch((error: unknown) => {
              console.warn("Telegram pair-confirm edit failed", {
                messageId,
                message: error instanceof Error ? error.message : String(error),
              });
            });
          }
        }
      } else if (
        data === "bot:pause" ||
        data === "bot:resume" ||
        data === "bot:restart"
      ) {
        const messageId = callback.message?.message_id;
        const actionLabel =
          data === "bot:pause"
            ? "pause"
            : data === "bot:resume"
              ? "resume"
              : "restart";
        if (!this.control) {
          if (typeof messageId === "number") {
            await this.editMessageText(
              messageId,
              "🤖 Bot control is not available in this process.",
            ).catch((error: unknown) => {
              console.warn("Telegram bot-control edit failed", {
                messageId,
                message: error instanceof Error ? error.message : String(error),
              });
            });
          }
        } else {
          // Live guard checked at click time: active trades or an
          // in-flight trade execution block every control action.
          // Restart double-clicks are safe because this re-check runs
          // inside the callback per click (requestRestart is idempotent:
          // the second click finds restartRequested already set).
          const [active, queueBusy] = await Promise.all([
            loadActiveTrades(this.db),
            Promise.resolve(this.executionQueue.isExecuting()),
          ]);
          if (active.length > 0 || queueBusy) {
            const refusal =
              active.length > 0
                ? `⛔ Cannot ${actionLabel}: there are ${active.length} ` +
                  `active trade(s) (${active
                    .map((trade) => `id ${trade.id}, status ${trade.status}`)
                    .join("; ")}).`
                : `⛔ Cannot ${actionLabel}: a trade execution is in progress.`;
            if (typeof messageId === "number") {
              await this.editMessageText(messageId, refusal).catch(
                (error: unknown) => {
                  console.warn("Telegram bot-control refusal edit failed", {
                    messageId,
                    message:
                      error instanceof Error ? error.message : String(error),
                  });
                },
              );
            }
          } else if (data === "bot:pause") {
            this.control.pause();
            const { text, markup } = this.buildBotControlPanel();
            await this.sendMessage(
              "⏸ Bot paused. Price and signal monitoring is stopped; " +
                "Telegram and the defensive monitor stay active.\n\n" +
                text,
              markup,
            );
          } else if (data === "bot:resume") {
            this.control.resume();
            const { text, markup } = this.buildBotControlPanel();
            await this.sendMessage(`▶️ Bot resumed.\n\n${text}`, markup);
          } else {
            let persistFailure: string | null = null;
            try {
              // Persist ALL FIVE runtime overrides so the restart (and
              // any future boot) re-applies them; failure never blocks
              // the restart — the operator is told instead.
              await Promise.all(
                (
                  [
                    "cooldownMinutes",
                    "minSpreadUsd",
                    "marginUsd",
                    "leverage",
                    "autoConfirm",
                  ] as const
                ).map((key) =>
                  persistRuntimeOverride(this.db, this.config, key),
                ),
              );
            } catch (error) {
              // persistRuntimeOverride already logs each row failure.
              persistFailure =
                error instanceof Error ? error.message : String(error);
              console.error(
                "Failed to persist runtime overrides before restart",
                { message: persistFailure },
              );
            }
            const restartText = persistFailure
              ? "🔄 Restarting the bot… ⚠️ Hot-adjusted settings could NOT be " +
                "saved and survive in memory only."
              : "🔄 Restarting the bot… Hot-adjusted settings were saved.";
            if (typeof messageId === "number") {
              await this.editMessageText(messageId, restartText).catch(
                (error: unknown) => {
                  console.warn("Telegram restart edit failed", {
                    messageId,
                    message:
                      error instanceof Error ? error.message : String(error),
                  });
                },
              );
            }
            // Cooperative restart: the polling loop sees the flag, exits,
            // and the process ends when main() returns (Docker restarts it).
            this.control.requestRestart();
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
                  `❌ Retry ${token.slice(0, 8)} finished without a definite ` +
                    `outcome. Check the logs before assuming it opened.`,
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
      } else if (data === "trade:active" || data === "trade:last10") {
        await this.sendMessage(
          data === "trade:active"
            ? await buildTradeSummaryMessage({
                db: this.db,
                registry: this.registry,
              })
            : await buildLastTradesMessage({
                db: this.db,
              }, this.config.telegram.operatorTimezone),
        );
      } else if (data.startsWith("volume:")) {
        const view = data.slice("volume:".length);
        if (view === "total" || view === "prevmonth" || view === "6m") {
          const messageId = callback.message?.message_id;
          if (typeof messageId === "number") {
            await this.editMessageText(
              messageId,
              await buildVolumeMessage(this.db, this.registry, view),
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

  private buildBotControlPanel(): { text: string; markup: unknown } {
    const paused = this.control?.isPaused() ?? false;
    const text =
      "🤖 Bot control\n" + `Status: ${paused ? "⏸ Paused" : "🟢 Active"}`;
    const markup = {
      inline_keyboard: paused
        ? [
            [
              { text: "▶️ Resume", callback_data: "bot:resume" },
              { text: "🔄 Restart", callback_data: "bot:restart" },
            ],
          ]
        : [
            [
              { text: "⏸ Pause", callback_data: "bot:pause" },
              { text: "🔄 Restart", callback_data: "bot:restart" },
            ],
          ],
    };
    return { text, markup };
  }

  private async sendBotControlPanel(): Promise<void> {
    if (!this.control) {
      await this.sendMessage(
        "🤖 Bot control not available: this process has no " +
          "pause/restart wiring.",
      );
      return;
    }
    const { text, markup } = this.buildBotControlPanel();
    await this.sendMessage(text, markup);
  }

  /**
   * Best-effort persistence of an applied runtime override. Returns a
   * warning suffix for the operator confirmation message, or an empty
   * string when the change was persisted.
   */
  private async persistAppliedChange(
    change: RuntimeSettingChange,
  ): Promise<string> {
    try {
      await persistRuntimeOverride(this.db, this.config, change.key);
      return "";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Telegram runtime override persistence failed", {
        key: change.key,
        message,
      });
      return `\n⚠️ Could not save it to survive a restart: ${message}`;
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
                  text: "Retry limit order",
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
          `⏱ Trade not opened (${token.slice(0, 8)}): the limit order ` +
            `expired without a fill and the trade was cancelled. ` +
            `Use "Retry limit order" to try again.`,
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
        `❌ Trade ${token.slice(0, 8)} finished without a definite ` +
          `outcome. Check the logs before assuming it opened.`,
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

const TRADE_PANEL_BUTTONS = [
  { text: "📊 Active trade", callback_data: "trade:active" },
  { text: "📜 Last 10 trades", callback_data: "trade:last10" },
] as const;

const TRADE_HISTORY_BUTTON = [
  { text: "📜 Last 10 trades", callback_data: "trade:last10" },
] as const;

type VolumeView = "total" | "prevmonth" | "6m";

const VOLUME_VIEW_BUTTONS = [
  { text: "Total", callback_data: "volume:total" },
  { text: "Previous month", callback_data: "volume:prevmonth" },
  { text: "6 months", callback_data: "volume:6m" },
] as const;

// Two buttons per row, in operator-priority order: the everyday alert
// settings first, the sizing settings second (margin + leverage derive the
// per-leg notional together), and the strategy-level row last — Pairs and
// the dangerous auto-trading toggle, which must never render glued to the
// everyday settings.
const RUNTIME_SETTING_BUTTONS = [
  [
    { text: "⏱ Cooldown", callback_data: "set:cooldown" },
    { text: "📏 Min spread", callback_data: "set:spread" },
  ],
  [
    { text: "💰 Margin", callback_data: "set:margin" },
    { text: "⚡️ Leverage", callback_data: "set:leverage" },
  ],
  [
    { text: "🪙 Pairs", callback_data: "set:pair" },
    { text: "🤖 Auto trade", callback_data: "set:autoconfirm" },
  ],
] as const;

/** Pair submenu buttons, generated from the shared TRADING_PAIRS catalog so
 * a new pair shows up here with no poller changes. The active pair carries
 * a ✅ marker. */
function buildPairsMenuMarkup(currentSymbol: string) {
  const rows = TRADING_PAIRS.map((pair) => [
    {
      text: `${pair.label}${pair.symbol === currentSymbol ? " ✅" : ""}`,
      callback_data: `pair:${pair.symbol}`,
    },
  ]);
  rows.push([{ text: "Cancel", callback_data: "set:cancel" }]);
  return { inline_keyboard: rows };
}

/** Confirmation row shown after the operator picks a pair and reviews its
 * 24h volumes. */
function buildPairConfirmMarkup(symbol: string) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Confirm", callback_data: `pair:apply:${symbol}` },
        { text: "❌ Cancel", callback_data: "set:cancel" },
      ],
    ],
  };
}

const SETTING_CANCEL_MARKUP = {
  inline_keyboard: [[{ text: "Cancel", callback_data: "set:cancel" }]],
};

const VOLUME_ATTRIBUTION_NOTE =
  "(exchange-reported account volume by fill month, UTC; · db = DB-sourced)";

/** Compact USD for the /volume message (operator request): K/M suffixes
 * with ONE decimal, rounded, dropping a trailing ".0" (10K, not 10.0K).
 * Values under 1k keep the exact cent-level rendering so small numbers
 * (per-exchange volume, monthly nets) stay precise. */
function formatCompactUsd(value: number): string {
  if (!Number.isFinite(value)) return "n/d";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${roundCompact(value / 1_000_000)}M`;
  if (abs >= 1_000) return `${roundCompact(value / 1_000)}K`;
  return value.toFixed(2);
}

/** One decimal, rounded; a round result drops the decimal (5, not 5.0). */
function roundCompact(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/** Compact signed PnL with the 🟢/🔴 icons, matching formatPnlColored's
 * shape but with the K/M compact amount. */
function formatCompactPnl(value: number): string {
  const icon = value >= 0 ? "🟢" : "🔴";
  const sign = value >= 0 ? "+" : "-";
  return `${icon} ${sign}$${formatCompactUsd(Math.abs(value))}`;
}

/** Two-line net-PnL block shown after the volume total in every /volume
 * view. The label is load-bearing: only fees persisted since the
 * fee-capture feature landed are summed (historical fees under-report),
 * and funding is out of scope. */
function formatNetPnlLines(net: NetPnlTotals): string[] {
  return [
    `Realized PnL: $${formatCompactUsd(net.realizedUsd)} · Fees: $${formatCompactUsd(net.feesUsd)}`,
    `Net: ${formatCompactPnl(net.netUsd)} (known trading fees, funding excluded)`,
  ];
}

/** Compact signed USD for inline per-month net suffixes. */
function formatSignedUsd(value: number): string {
  return value >= 0
    ? `+$${formatCompactUsd(value)}`
    : `-$${formatCompactUsd(Math.abs(value))}`;
}

/** Available-balance block for every /volume view: one line per registered
 * exchange, exchange-direct via each execution adapter's
 * getAvailableMarginUsd, plus a total over the exchanges that reported.
 * A fetch failure renders "n/d" — never estimated; the total only sums
 * known balances and is omitted when every fetch failed. */
async function formatAvailableBalanceLines(
  registry: ExchangeRegistryLike,
): Promise<string[]> {
  const balances = await loadAvailableBalances(registry);
  if (balances.length === 0) return [];
  const known = balances.filter((entry) => entry.usd !== null);
  const totalUsd = known.reduce((sum, entry) => sum + (entry.usd ?? 0), 0);
  return [
    "Available balance (USDC):",
    ...balances.map((entry) =>
      `  ${entry.exchangeId}: ${entry.usd === null ? "n/d" : `$${formatCompactUsd(entry.usd)}`}`,
    ),
    ...(known.length > 0
      ? [`  Total (${known.length}/${balances.length}): $${formatCompactUsd(totalUsd)}`]
      : []),
  ];
}

function formatExchangeVolumeLines(
  byExchange: Array<{ exchangeId: string; usd: number }>,
  exchangesFromDb: string[],
): string[] {
  if (byExchange.length === 0) return [];
  return [
    "By exchange:",
    ...byExchange.map(
      (entry) =>
        `  ${entry.exchangeId}${exchangesFromDb.includes(entry.exchangeId) ? " · db" : ""}: $${formatCompactUsd(entry.usd)}`,
    ),
  ];
}

/** Renders one of the /volume views. Volume is exchange-direct: the exchange-
 * reported account fills for every registered exchange (exchange-volume), so
 * manual trades on the accounts count too; an exchange whose fetch fails is
 * marked "· db" and shows its DB numbers instead. Only the net-PnL block
 * stays DB-based (realized minus known trading fees; funding excluded,
 * historical fees under-report). */
async function buildVolumeMessage(
  db: Awaited<ReturnType<typeof getDb>>,
  registry: ExchangeRegistryLike,
  view: VolumeView,
): Promise<string> {
  if (view === "prevmonth") {
    const range = previousMonthRange();
    const [stats, balanceLines] = await Promise.all([
      loadExchangeVolume(db, registry, {
        from: range.from,
        to: range.to,
      }),
      formatAvailableBalanceLines(registry),
    ]);
    const net = await loadNetPnlTotals(db, range);
    return [
      `📊 Generated volume — ${range.label}`,
      `Total: $${formatCompactUsd(stats.totalUsd)}`,
      ...formatNetPnlLines(net),
      ...formatExchangeVolumeLines(stats.byExchange, stats.exchangesFromDb),
      ...balanceLines,
      VOLUME_ATTRIBUTION_NOTE,
    ].join("\n");
  }
  if (view === "6m") {
    const from = lastSixMonthsFrom();
    const [stats, balanceLines] = await Promise.all([
      loadExchangeVolume(db, registry, { from }),
      formatAvailableBalanceLines(registry),
    ]);
    const netMonths = await loadMonthlyNetPnlBreakdown(db, from);
    const net = await loadNetPnlTotals(db, { from });
    const byMonth = stats.byMonth;
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
          ? " (in progress)"
          : "";
      // Months with no realized PnL have no net row: no suffix, rather
      // than a misleading "+0.00".
      const netSuffix = netByMonth.has(label)
        ? ` · net ${formatSignedUsd(netByMonth.get(label) ?? 0)}`
        : "";
      monthLines.push(
        `${label}: $${formatCompactUsd(byMonth.get(label) ?? 0)}${suffix}${netSuffix}`,
      );
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    return [
      "📊 Generated volume — last 6 months",
      ...monthLines,
      `Period total: $${formatCompactUsd(stats.totalUsd)}`,
      ...formatNetPnlLines(net),
      ...formatExchangeVolumeLines(stats.byExchange, stats.exchangesFromDb),
      ...balanceLines,
      VOLUME_ATTRIBUTION_NOTE,
    ].join("\n");
  }
  const [stats, balanceLines] = await Promise.all([
    loadExchangeVolume(db, registry),
    formatAvailableBalanceLines(registry),
  ]);
  const net = await loadNetPnlTotals(db);
  return [
    "📊 Generated volume",
    `Lifetime total: $${formatCompactUsd(stats.totalUsd)}`,
    ...formatNetPnlLines(net),
    ...formatExchangeVolumeLines(stats.byExchange, stats.exchangesFromDb),
    ...balanceLines,
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
  const leverageOverridden =
    baseline != null &&
    isRuntimeSettingOverridden("leverage", baseline, config);
  const cooldownOverridden =
    baseline != null &&
    isRuntimeSettingOverridden("cooldownMinutes", baseline, config);
  const autoConfirmOverridden =
    baseline != null &&
    isRuntimeSettingOverridden("autoConfirm", baseline, config);
  const tradingPairOverridden =
    baseline != null &&
    isRuntimeSettingOverridden("tradingPair", baseline, config);
  const lines = [
    "⚙️ Active bot configuration",
    "",
    `Symbol: ${config.btcSymbol}${tradingPairOverridden ? " *" : ""}`,
    `Market: ${config.marketType}`,
    `Price source: ${config.priceSource}`,
    `Poll interval: ${config.pricePollIntervalMs} ms`,
    `Min spread: $${formatUsd(config.minPriceDiffUsd)}${minSpreadOverridden ? " *" : ""}`,
    `Leverage: ${config.leverage}x${leverageOverridden ? " *" : ""}`,
    `Mode: ${config.botExecutionMode}`,
    `Open trade margin: $${formatUsd(config.openTrade.marginUsd)} per leg (notional $${formatUsd(config.openTrade.notionalUsd)} at ${config.leverage}x)${marginOverridden ? " *" : ""}`,
    `Open trade TP/SL: TP: ${config.openTrade.takeProfitPercent}% / SL: -${config.openTrade.stopLossPercent}%`,
    `Auto-confirm (auto-trading): ${config.openTrade.autoConfirm ? "ON 🤖" : "off"}${autoConfirmOverridden ? " *" : ""}`,
    `Telegram cooldown: ${config.telegram.alertCooldownMs} ms${cooldownOverridden ? " *" : ""}`,
    "",
    formatExchangeLine("Exchange A", config.exchangeA, config),
    formatExchangeLine("Exchange B", config.exchangeB, config),
  ];
  if (
    minSpreadOverridden ||
    marginOverridden ||
    leverageOverridden ||
    cooldownOverridden ||
    autoConfirmOverridden ||
    tradingPairOverridden
  ) {
    lines.push("", "(* adjusted at runtime — does not persist across restarts)");
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
        `⏱ Stale quote: the price arrived more than ${Math.round(quoteMaxAgeMs / 1000)}s old. ` +
        'Tap "Open Trade" again.'
      );
    case "Preview expired; open a new trade from a fresh signal":
      return '⌛ The signal preview expired. Wait for a new signal and tap "Open Trade" there.';
    case "Preview was already consumed, cancelled or expired":
      return "↪️ That action was already used or expired. If the trade did not open, use a new signal.";
    case "Signal no longer exists":
      return "🔍 The signal no longer exists (it may have been cleaned up). Wait for the next signal.";
    case "Trade not available for retry":
      return "🔁 That trade is not available for retry.";
    default:
      return `❌ Could not complete: ${raw}`;
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
