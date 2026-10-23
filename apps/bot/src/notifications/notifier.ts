import type { MetalRatioSide, TradingSignal } from '@btc-arbitrage/domain';

/** Payload for a gold/silver ratio RSI-cross alert (v1 monitor-only). */
export interface MetalRatioSignalNotification {
  side: MetalRatioSide;
  rsi: string;
  rsiPeriod: number;
  /** Raw ETF ratio (GLD-USD / SLV-USD perp mark prices). */
  ratio: string;
  goldPriceUsd: string;
  silverPriceUsd: string;
  /** Configured net TP target reserved for the future execution phase. */
  takeProfitNetUsd: string;
  calculatedAt: Date;
}

export interface Notifier {
  notifySignal(signal: TradingSignal): Promise<void>;
  notifyUrgent(text: string): Promise<void>;
  notifyMetalRatioSignal(signal: MetalRatioSignalNotification): Promise<void>;
}
