import type { TradingSignal } from '@btc-arbitrage/domain';
import type { TelegramInlineKeyboard } from './telegram-notifier.js';

export interface Notifier {
  notifySignal(signal: TradingSignal): Promise<void>;
  notifyUrgent(text: string): Promise<void>;
}
