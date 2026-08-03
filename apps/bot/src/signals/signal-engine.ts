import type { SpreadSnapshot, TradingSignal } from '@btc-arbitrage/domain';
import { parseDecimal } from '@btc-arbitrage/domain';

export interface SignalEngineOptions {
  thresholdUsd: string;
  leverage: number;
}

export class SignalEngine {
  constructor(private readonly options: SignalEngineOptions) {}

  evaluate(spread: SpreadSnapshot): TradingSignal | null {
    if (parseDecimal(spread.absoluteDiffUsd, 'absoluteDiffUsd') < parseDecimal(this.options.thresholdUsd, 'thresholdUsd')) {
      return null;
    }

    const longExchange = spread.direction === 'a_above_b' ? spread.exchangeB : spread.exchangeA;
    const shortExchange = spread.direction === 'a_above_b' ? spread.exchangeA : spread.exchangeB;

    return {
      spreadId: spread.id,
      symbol: spread.symbol,
      marketType: spread.marketType,
      priceSource: spread.priceSource,
      exchangeA: spread.exchangeA,
      exchangeB: spread.exchangeB,
      longExchange,
      shortExchange,
      exchangeAPriceUsd: spread.exchangeAPriceUsd,
      exchangeBPriceUsd: spread.exchangeBPriceUsd,
      absoluteDiffUsd: spread.absoluteDiffUsd,
      thresholdUsd: this.options.thresholdUsd,
      leverage: this.options.leverage,
      reason: `Absolute BTC price diff ${spread.absoluteDiffUsd} >= configured threshold ${this.options.thresholdUsd}`,
      status: 'created',
      createdAt: new Date()
    };
  }
}
