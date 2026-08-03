import type { TradingSignal } from '@btc-arbitrage/domain';

export interface Notifier {
  notifySignal(signal: TradingSignal): Promise<void>;
}
