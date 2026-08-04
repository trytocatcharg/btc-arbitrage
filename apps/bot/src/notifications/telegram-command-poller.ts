import type { BotConfig } from '@btc-arbitrage/config';
import { isAllowedTelegramChat, normalizeTelegramChatId, type FetchLike } from './telegram-notifier.js';

export interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    chat?: {
      id?: string | number;
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
    command: 'config',
    description: 'Show active bot configuration'
  }
] as const;

export class TelegramCommandPoller {
  private offset = 0;

  constructor(
    private readonly config: BotConfig,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async configureAvailableCommands(): Promise<void> {
    if (!this.config.telegram.enabled) return;
    if (!this.config.telegram.botToken || !this.config.telegram.chatId) return;

    const response = await this.fetchImpl(`https://api.telegram.org/bot${this.config.telegram.botToken}/setMyCommands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commands: AVAILABLE_COMMANDS,
        scope: {
          type: 'chat',
          chat_id: normalizeTelegramChatId(this.config.telegram.chatId)
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Telegram setMyCommands failed with HTTP ${response.status}`);
    }

    const payload = await response.json() as TelegramApiResponse;
    if (!payload.ok) {
      throw new Error(`Telegram setMyCommands returned ok=false${payload.description ? `: ${payload.description}` : ''}`);
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
    const url = new URL(`https://api.telegram.org/bot${this.config.telegram.botToken}/getUpdates`);
    url.searchParams.set('offset', String(this.offset));
    url.searchParams.set('timeout', '0');
    url.searchParams.set('allowed_updates', JSON.stringify(['message']));

    const response = await this.fetchImpl(url.toString());
    if (!response.ok) {
      throw new Error(`Telegram getUpdates failed with HTTP ${response.status}`);
    }

    const payload = await response.json() as TelegramUpdatesResponse;
    if (!payload.ok) {
      throw new Error('Telegram getUpdates returned ok=false');
    }

    return payload.result ?? [];
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message) return;

    const text = message?.text?.trim();
    if (!text) return;

    if (!isAllowedTelegramChat(message.chat, this.config.telegram.chatId!)) {
      console.warn('Telegram command ignored from unauthorized chat', {
        updateId: update.update_id,
        chatId: message.chat?.id
      });
      return;
    }

    if (isTelegramCommand(text, 'config')) {
      await this.sendMessage(formatActiveConfigSummary(this.config));
    }
  }

  private async sendMessage(text: string): Promise<void> {
    const response = await this.fetchImpl(`https://api.telegram.org/bot${this.config.telegram.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: normalizeTelegramChatId(this.config.telegram.chatId!),
        text,
        disable_web_page_preview: true
      })
    });

    if (!response.ok) {
      throw new Error(`Telegram sendMessage failed with HTTP ${response.status}`);
    }
  }
}

export function formatActiveConfigSummary(config: BotConfig): string {
  return [
    '⚙️ Active bot configuration',
    '',
    `Symbol: ${config.btcSymbol}`,
    `Market: ${config.marketType}`,
    `Price source: ${config.priceSource}`,
    `Poll interval: ${config.pricePollIntervalMs} ms`,
    `Min spread: $${formatUsd(config.minPriceDiffUsd)}`,
    `Leverage: ${config.leverage}x`,
    `Mode: ${config.botExecutionMode}`,
    `Order placement: ${config.enableOrderPlacement ? 'enabled' : 'disabled'}`,
    `Telegram cooldown: ${config.telegram.alertCooldownMs} ms`,
    '',
    formatExchangeLine('Exchange A', config.exchangeA, config),
    formatExchangeLine('Exchange B', config.exchangeB, config)
  ].join('\n');
}

function isTelegramCommand(text: string, command: string): boolean {
  const firstToken = text.split(/\s+/, 1)[0]?.toLowerCase();
  return firstToken === `/${command}` || firstToken?.startsWith(`/${command}@`) === true;
}

function formatExchangeLine(label: string, exchangeId: BotConfig['exchangeA'], config: BotConfig): string {
  const exchange = config[exchangeId];
  return `${label}: ${exchangeId} (${exchange.apiBaseUrl}, trading ${exchange.tradingEnabled ? 'enabled' : 'disabled'})`;
}

function formatUsd(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return parsed.toFixed(2);
}
