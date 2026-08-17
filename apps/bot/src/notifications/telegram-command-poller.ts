import type { BotConfig } from '@btc-arbitrage/config';
import type { getDb } from '@btc-arbitrage/db';
import { signals } from '@btc-arbitrage/db';
import { eq } from 'drizzle-orm';
import { buildTradeSummaryMessage, type ExchangeRegistryLike } from './trade-summary.js';
import { isAllowedTelegramChat, normalizeTelegramChatId, type FetchLike } from './telegram-notifier.js';
import { DbPreviewStore } from '../trading/db-preview-store.js';
import { OpenTradeService } from '../trading/open-trade.js';
import { RisexTpSlSmokeTestService } from '../trading/risex-tpsl-smoke-test.js';

export interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    chat?: {
      id?: string | number;
    };
  };
  callback_query?: { id: string; data?: string; message?: { chat?: { id?: string | number } } };
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
  },
  {
    command: 'trade',
    description: 'Show open trade summary'
  },
  {
    command: 'risextpsl',
    description: 'Capture RISEx TP/SL diagnostics'
  },
  {
    command: 'risexlivetpsl',
    description: 'Place real RISEx long + TP/SL smoke test'
  }
] as const;

export class TelegramCommandPoller {
  private offset = 0;

  constructor(
    private readonly config: BotConfig,
    private readonly db: Awaited<ReturnType<typeof getDb>>,
    private readonly registry: ExchangeRegistryLike,
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
    url.searchParams.set('allowed_updates', JSON.stringify(['message', 'callback_query']));

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
    if (update.callback_query) { await this.handleCallback(update.callback_query); return; }
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
      return;
    }

    if (isTelegramCommand(text, 'trade')) {
      await this.sendMessage(await buildTradeSummaryMessage({ db: this.db, registry: this.registry }));
      return;
    }

    if (isTelegramCommand(text, 'risextpsl')) {
      await this.sendMessage(await this.captureRisexTpslDiagnostics());
      return;
    }

    if (isTelegramCommand(text, 'risexlivetpsl')) {
      await this.sendMessage(await this.runRisexLiveTpSlSmokeTest());
      return;
    }
  }

  private async handleCallback(callback: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
    if (!isAllowedTelegramChat(callback.message?.chat, this.config.telegram.chatId!)) return;
    const data = callback.data ?? '';
    try {
      if (data.startsWith('open:')) {
        const signalId = Number(data.slice(5)); const signal = (await this.db.select().from(signals).where(eq(signals.id, signalId)))[0];
        if (!signal) throw new Error('Signal no longer exists');
        const service = this.openTradeService();
        const preview = await service.createPreview({ signalId, symbol: this.config.btcSymbol, marketType: this.config.marketType, exchanges: [signal.longExchange as BotConfig['exchangeA'], signal.shortExchange as BotConfig['exchangeA']] });
        await this.sendMessage(`Trade preview\nLong: ${preview.longExchange} @ $${preview.longPriceUsd}\nShort: ${preview.shortExchange} @ $${preview.shortPriceUsd}\nQuantity: ${preview.quantityBase} BTC\nExpires: ${preview.expiresAt.toISOString()}`, { inline_keyboard: [[{ text: 'Confirm', callback_data: `confirm:${preview.token}` }, { text: 'Cancel', callback_data: `cancel:${preview.token}` }]] });
      } else if (data.startsWith('confirm:')) { await this.openTradeService().confirm(data.slice(8)); await this.sendMessage('Trade execution completed.'); }
      else if (data.startsWith('cancel:')) { await new DbPreviewStore(this.db).transition(data.slice(7), 'cancelled'); await this.sendMessage('Trade preview cancelled.'); }
      await this.answerCallback(callback.id);
    } catch (error) { await this.answerCallback(callback.id, error instanceof Error ? error.message : 'Trade action failed'); }
  }

  private openTradeService(): OpenTradeService {
    return new OpenTradeService(this.registry, new DbPreviewStore(this.db), { notionalUsd: this.config.openTrade.notionalUsd, ttlMs: this.config.openTrade.previewTtlMs, quoteMaxAgeMs: this.config.openTrade.quoteMaxAgeMs, limitTimeoutMs: this.config.openTrade.limitTimeoutMs, residualDeltaToleranceBase: this.config.openTrade.residualDeltaToleranceBase, notifyUrgent: (text) => this.sendMessage(text), fees: { risex: { makerBps: this.config.openTrade.risexMakerFeeBps, takerBps: this.config.openTrade.risexTakerFeeBps }, extended: { makerBps: this.config.openTrade.extendedMakerFeeBps, takerBps: this.config.openTrade.extendedTakerFeeBps }, arcus: { makerBps: '0', takerBps: '0' } } });
  }

  private async captureRisexTpslDiagnostics(): Promise<string> {
    const adapter = this.registry.get('risex');
    const execution = adapter.execution;
    if (!execution) throw new Error('RISEx execution adapter is not available');
    const risexExecution = execution as typeof execution & { getOpenOrders?: (input?: { symbol?: string }) => Promise<unknown[]>; getOpenTpslOrders?: (input?: { symbol?: string }) => Promise<unknown[]> };
    const [priceSnapshot, bboResult, metadata, margin, longPosition, shortPosition, openOrders, openTpslOrders] = await Promise.all([
      adapter.getPriceSnapshot({ symbol: this.config.btcSymbol, marketType: this.config.marketType, priceSource: this.config.priceSource }),
      execution.getBestBidOffer({ symbol: this.config.btcSymbol, marketType: this.config.marketType, priceSource: 'last' }).then((value) => ({ ok: true as const, value })).catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) })),
      execution.getMarketMetadata({ symbol: this.config.btcSymbol, marketType: this.config.marketType, priceSource: 'last' }),
      execution.getAvailableMarginUsd(),
      execution.getPosition({ symbol: this.config.btcSymbol, side: 'long' }),
      execution.getPosition({ symbol: this.config.btcSymbol, side: 'short' }),
      risexExecution.getOpenOrders?.({ symbol: this.config.btcSymbol }) ?? Promise.resolve([]),
      risexExecution.getOpenTpslOrders?.({ symbol: this.config.btcSymbol }) ?? Promise.resolve([])
    ]);

    return [
      'RISEx TP/SL diagnostics captured',
      `Symbol: ${this.config.btcSymbol}`,
      `Reference price (${this.config.priceSource}): $${priceSnapshot.priceUsd}`,
      bboResult.ok ? `BBO: bid $${bboResult.value.bidUsd} / ask $${bboResult.value.askUsd}` : `BBO: unavailable (${bboResult.error})`,
      `Min qty: ${metadata.minQuantityBase}`,
      `Step qty: ${metadata.quantityStepBase}`,
      `Margin: $${margin}`,
      `Long position: ${longPosition ? `${longPosition.status} ${longPosition.quantityBase}` : 'none'}`,
      `Short position: ${shortPosition ? `${shortPosition.status} ${shortPosition.quantityBase}` : 'none'}`,
      `Open orders: ${openOrders.length}`,
      `Open TP/SL orders: ${openTpslOrders.length}`,
      'JSON log file: logs/risex-http.jsonl'
    ].join('\n');
  }

  private async runRisexLiveTpSlSmokeTest(): Promise<string> {
    const result = await new RisexTpSlSmokeTestService(this.config, this.registry).run();
    if (!result.entryFilled) {
      return [
        'RISEx live TP/SL smoke test submitted',
        `Entry order: ${result.entryOrderId}`,
        `Limit buy: $${result.entryLimitPriceUsd}`,
        `Quantity: ${result.quantityBase}`,
        `TP trigger prepared: $${result.takeProfitTriggerPriceUsd}`,
        `SL trigger prepared: $${result.stopLossTriggerPriceUsd}`,
        'Entry was NOT filled within 30 seconds, so TP/SL orders were NOT sent.',
        'This is expected on RISEx because trigger TPSL orders require an open position.'
      ].join('\n');
    }

    return [
      'RISEx live TP/SL smoke test completed',
      `Entry order: ${result.entryOrderId}`,
      `Limit buy: $${result.entryLimitPriceUsd}`,
      `Quantity: ${result.quantityBase}`,
      `TP order: ${result.takeProfitOrderId} @ trigger $${result.takeProfitTriggerPriceUsd}`,
      `SL order: ${result.stopLossOrderId} @ trigger $${result.stopLossTriggerPriceUsd}`,
      'Operator budget approval was submitted before TPSL placement.',
      'You said you will close the position manually; TP/SL were created only to validate RISEx.'
    ].join('\n');
  }

  private async answerCallback(id: string, text?: string): Promise<void> { await this.fetchImpl(`https://api.telegram.org/bot${this.config.telegram.botToken}/answerCallbackQuery`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callback_query_id: id, ...(text ? { text, show_alert: true } : {}) }) }); }
  private async sendMessage(text: string, replyMarkup?: unknown): Promise<void> {
    for (const chunk of splitTelegramMessage(text)) {
      const response = await this.fetchImpl(`https://api.telegram.org/bot${this.config.telegram.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: normalizeTelegramChatId(this.config.telegram.chatId!),
          text: chunk,
          disable_web_page_preview: true,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {})
        })
      });

      if (!response.ok) {
        throw new Error(`Telegram sendMessage failed with HTTP ${response.status}`);
      }
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

function splitTelegramMessage(text: string, maxChunkLength = 3900): string[] {
  if (text.length <= maxChunkLength) return [text];

  const paragraphs = text.split('\n\n');
  const chunks: string[] = [];
  let current = '';

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxChunkLength) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = '';
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
