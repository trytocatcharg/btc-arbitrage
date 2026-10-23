import type { TradingSignal } from "@btc-arbitrage/domain";
import type { MetalRatioSignalNotification, Notifier } from "./notifier.js";

// 2026-09-28: a hung Telegram request froze the bot's polling loop forever
// (no timeout anywhere in the bot). Every outbound call now aborts after
// 10 s so the notifier fails fast instead of blocking the loop.
const TELEGRAM_REQUEST_TIMEOUT_MS = 10_000;

export interface TelegramConfig {
  enabled: boolean;
  botToken?: string;
  chatId?: string;
  alertCooldownMs?: number;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Telegram inline keyboard for urgent alerts that carry an action button
 * (e.g. the position reconciler's Close-position button). Structurally
 * identical to position-reconciler's UntrackedKeyboard; kept as a separate
 * local type so neither module imports the other. */
export interface TelegramInlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export interface TelegramChatLike {
  id?: string | number;
}

export interface TelegramUserLike {
  id?: string | number;
}

export class TelegramNotifier implements Notifier {
  private lastNotificationAttemptAtMs = 0;

  constructor(
    private readonly config: TelegramConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async notifySignal(signal: TradingSignal): Promise<void> {
    if (!this.config.enabled) return;
    if (!this.config.botToken || !this.config.chatId) {
      throw new Error("Telegram is enabled but token/chat id are missing");
    }
    const allowedChatId = normalizeTelegramChatId(this.config.chatId);

    if (this.isSuppressedByCooldown()) return;
    this.lastNotificationAttemptAtMs = this.now();

    console.log("Sending Telegram signal notification", {
      signalId: signal.id ?? null,
      hasOpenTradeButton: Boolean(signal.id),
      longExchange: signal.longExchange,
      shortExchange: signal.shortExchange,
      spreadUsd: signal.absoluteDiffUsd,
    });

    const response = await this.fetchWithTimeout(
      `https://api.telegram.org/bot${this.config.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: allowedChatId,
          text: formatTelegramSignal(signal),
          disable_web_page_preview: true,
          ...(signal.id
            ? {
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: "Open Trade",
                        callback_data: `open:${signal.id}`,
                      },
                    ],
                  ],
                },
              }
            : {}),
        }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Telegram sendMessage failed with HTTP ${response.status}`,
      );
    }
  }
  async notifyUrgent(
    text: string,
    keyboard?: TelegramInlineKeyboard,
  ): Promise<void> {
    if (!this.config.enabled || !this.config.botToken || !this.config.chatId)
      return;
    const response = await this.fetchWithTimeout(
      `https://api.telegram.org/bot${this.config.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: normalizeTelegramChatId(this.config.chatId),
          text,
          disable_web_page_preview: true,
          ...(keyboard ? { reply_markup: keyboard } : {}),
        }),
      },
    );
    if (!response.ok)
      throw new Error(
        `Telegram urgent message failed with HTTP ${response.status}`,
      );
  }

  /** Gold/silver ratio RSI-cross alert (v1 monitor-only). No inline
   * buttons and no notifier-side cooldown: the metal-ratio engine owns the
   * alert cadence via GOLDSILVER_ALERT_COOLDOWN_MS. */
  async notifyMetalRatioSignal(
    signal: MetalRatioSignalNotification,
  ): Promise<void> {
    if (!this.config.enabled || !this.config.botToken || !this.config.chatId)
      return;
    const response = await this.fetchWithTimeout(
      `https://api.telegram.org/bot${this.config.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: normalizeTelegramChatId(this.config.chatId),
          text: formatMetalRatioSignal(signal),
          disable_web_page_preview: true,
        }),
      },
    );
    if (!response.ok)
      throw new Error(
        `Telegram metal-ratio message failed with HTTP ${response.status}`,
      );
  }

  private fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
    return this.fetchImpl(url, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS),
    });
  }

  private isSuppressedByCooldown(): boolean {
    const cooldownMs = this.config.alertCooldownMs ?? 3_600_000;
    if (cooldownMs <= 0) return false;
    return (
      this.lastNotificationAttemptAtMs > 0 &&
      this.now() - this.lastNotificationAttemptAtMs < cooldownMs
    );
  }
}

export function formatTelegramSignal(signal: TradingSignal): string {
  return [
    "BTC arbitrage signal",
    `Symbol: ${signal.symbol}`,
    `Source: ${signal.priceSource}`,
    `Price ${signal.exchangeA}: $${formatUsdAmount(signal.exchangeAPriceUsd)}`,
    `Price ${signal.exchangeB}: $${formatUsdAmount(signal.exchangeBPriceUsd)}`,
    `Long  📈: ${signal.longExchange}`,
    `Short 📉: ${signal.shortExchange}`,
    `Spread: $${formatUsdAmount(signal.absoluteDiffUsd)}`,
    `Threshold: $${signal.thresholdUsd}`,
    `Leverage: ${signal.leverage}x`,
    "Action: tap Open Trade to open the trade immediately (no confirmation step)",
  ].join("\n");
}

/** Metal-equivalent conversion factor for the ETF ratio display: one GLD
 * share tracks ~0.0934 oz of gold and one SLV share ~0.918 oz of silver, so
 * metal_ratio = (GLD/0.0934)/(SLV/0.918) = etf_ratio x (0.918/0.0934) ~ x9.83.
 * Operator decision: display with the rounded factor 10.0. */
const ETF_TO_METAL_RATIO_FACTOR = 10.0;

export function formatMetalRatioSignal(
  signal: MetalRatioSignalNotification,
): string {
  const direction =
    signal.side === "short_gold_long_silver"
      ? "SHORT GOLD / LONG SILVER"
      : "LONG GOLD / SHORT SILVER";
  const crossDescription =
    signal.side === "short_gold_long_silver"
      ? "crossed above 50"
      : "crossed below 50";
  const metalRatio = Number(signal.ratio) * ETF_TO_METAL_RATIO_FACTOR;
  return [
    "🥇🥈 Gold/Silver ratio signal (monitor-only)",
    `Direction: ${direction}`,
    `RSI(${signal.rsiPeriod}): ${formatRsi(signal.rsi)} (${crossDescription})`,
    `Ratio (ETF shares): ${signal.ratio}`,
    `Ratio (metal-equivalent): ${Number.isFinite(metalRatio) ? metalRatio.toFixed(1) : signal.ratio}`,
    `GLD-USD mark: $${formatUsdAmount(signal.goldPriceUsd)}`,
    `SLV-USD mark: $${formatUsdAmount(signal.silverPriceUsd)}`,
    `Plan: TP when RSI returns to 50 with net >= breakeven + $${formatUsdAmount(signal.tpMinNetUsd)} · SL at -${signal.stopLossMarginPercent}% margin (market)`,
    "Entry on confirm: passive limit on GLD + immediate market hedge on SLV.",
  ].join("\n");
}

function formatRsi(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return parsed.toFixed(2);
}

function formatUsdAmount(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return parsed.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function normalizeTelegramChatId(chatId: string | number): string {
  const normalized = String(chatId).trim();
  if (!normalized) throw new Error("Telegram chat id cannot be empty");
  return normalized;
}

export function isAllowedTelegramChat(
  chat: TelegramChatLike | undefined,
  allowedChatId: string | number,
): boolean {
  if (!chat?.id && chat?.id !== 0) return false;
  return (
    normalizeTelegramChatId(chat.id) === normalizeTelegramChatId(allowedChatId)
  );
}

export function assertAllowedTelegramChat(
  chat: TelegramChatLike | undefined,
  allowedChatId: string | number,
): void {
  if (!isAllowedTelegramChat(chat, allowedChatId)) {
    throw new Error("Telegram update rejected: chat id is not allowed");
  }
}

export function isAllowedTelegramUser(
  user: TelegramUserLike | undefined,
  allowedUserId: string | number,
): boolean {
  if (!user?.id && user?.id !== 0) return false;
  return (
    normalizeTelegramChatId(user.id) === normalizeTelegramChatId(allowedUserId)
  );
}

export function assertAllowedTelegramUser(
  user: TelegramUserLike | undefined,
  allowedUserId: string | number,
): void {
  if (!isAllowedTelegramUser(user, allowedUserId)) {
    throw new Error("Telegram update rejected: user id is not allowed");
  }
}
