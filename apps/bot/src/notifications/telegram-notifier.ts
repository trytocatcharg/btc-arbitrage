import type { TradingSignal } from '@btc-arbitrage/domain';
import type { Notifier } from './notifier.js';

export interface TelegramConfig {
  enabled: boolean;
  botToken?: string;
  chatId?: string;
  alertCooldownMs?: number;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface TelegramChatLike {
  id?: string | number;
}

export class TelegramNotifier implements Notifier {
  private lastNotificationAttemptAtMs = 0;

  constructor(private readonly config: TelegramConfig, private readonly fetchImpl: FetchLike = fetch, private readonly now: () => number = Date.now) {}

  async notifySignal(signal: TradingSignal): Promise<void> {
    if (!this.config.enabled) return;
    if (!this.config.botToken || !this.config.chatId) {
      throw new Error('Telegram is enabled but token/chat id are missing');
    }
    const allowedChatId = normalizeTelegramChatId(this.config.chatId);

    if (this.isSuppressedByCooldown()) return;
    this.lastNotificationAttemptAtMs = this.now();

    const response = await this.fetchImpl(`https://api.telegram.org/bot${this.config.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: allowedChatId,
        text: formatTelegramSignal(signal),
        disable_web_page_preview: true,
        ...(signal.id ? { reply_markup: { inline_keyboard: [[{ text: 'Open Trade', callback_data: `open:${signal.id}` }]] } } : {})
      })
    });

    if (!response.ok) {
      throw new Error(`Telegram sendMessage failed with HTTP ${response.status}`);
    }
  }
  async notifyUrgent(text: string): Promise<void> {
    if (!this.config.enabled || !this.config.botToken || !this.config.chatId) return;
    const response = await this.fetchImpl(`https://api.telegram.org/bot${this.config.botToken}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: normalizeTelegramChatId(this.config.chatId), text, disable_web_page_preview: true }) });
    if (!response.ok) throw new Error(`Telegram urgent message failed with HTTP ${response.status}`);
  }

  private isSuppressedByCooldown(): boolean {
    const cooldownMs = this.config.alertCooldownMs ?? 3_600_000;
    if (cooldownMs <= 0) return false;
    return this.lastNotificationAttemptAtMs > 0 && this.now() - this.lastNotificationAttemptAtMs < cooldownMs;
  }
}

export function formatTelegramSignal(signal: TradingSignal): string {
  return [
    'BTC arbitrage signal',
    `Symbol: ${signal.symbol}`,
    `Source: ${signal.priceSource}`,
    `Long  📈: ${signal.longExchange}`,
    `Short 📉: ${signal.shortExchange}`,
    `Spread: $${formatUsdAmount(signal.absoluteDiffUsd)}`,
    `Threshold: $${signal.thresholdUsd}`,
    `Leverage: ${signal.leverage}x`,
    'Mode: dry-run / no live order submitted'
  ].join('\n');
}

function formatUsdAmount(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return parsed.toFixed(2);
}

export function normalizeTelegramChatId(chatId: string | number): string {
  const normalized = String(chatId).trim();
  if (!normalized) throw new Error('Telegram chat id cannot be empty');
  return normalized;
}

export function isAllowedTelegramChat(chat: TelegramChatLike | undefined, allowedChatId: string | number): boolean {
  if (!chat?.id && chat?.id !== 0) return false;
  return normalizeTelegramChatId(chat.id) === normalizeTelegramChatId(allowedChatId);
}

export function assertAllowedTelegramChat(chat: TelegramChatLike | undefined, allowedChatId: string | number): void {
  if (!isAllowedTelegramChat(chat, allowedChatId)) {
    throw new Error('Telegram update rejected: chat id is not allowed');
  }
}
