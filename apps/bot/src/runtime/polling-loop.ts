import { calculateSpread } from '@btc-arbitrage/domain';
import { sleep } from '@btc-arbitrage/shared';
import type { BotConfig } from '@btc-arbitrage/config';
import type { ExchangeAdapter } from '@btc-arbitrage/exchange-core';
import { SignalEngine } from '../signals/signal-engine.js';
import type { Notifier } from '../notifications/notifier.js';

export interface ExchangeRegistry {
  get(id: string): ExchangeAdapter;
}

export async function runPollingLoop(input: { config: BotConfig; registry: ExchangeRegistry; notifier: Notifier }): Promise<void> {
  const signalEngine = new SignalEngine({ thresholdUsd: input.config.minPriceDiffUsd, leverage: input.config.leverage });
  const exchangeA = input.registry.get(input.config.exchangeA);
  const exchangeB = input.registry.get(input.config.exchangeB);
  let tick = 0;

  console.log('Monitoring loop ready', {
    exchangeA: input.config.exchangeA,
    exchangeB: input.config.exchangeB,
    symbol: input.config.btcSymbol,
    marketType: input.config.marketType,
    priceSource: input.config.priceSource,
    pollIntervalMs: input.config.pricePollIntervalMs,
    minPriceDiffUsd: input.config.minPriceDiffUsd
  });

  while (!isShuttingDown()) {
    tick += 1;
    const tickStartedAt = new Date();
    console.log('Monitoring tick started', {
      tick,
      startedAt: tickStartedAt.toISOString()
    });

    try {
      const [priceA, priceB] = await Promise.all([
        exchangeA.getPriceSnapshot({ symbol: input.config.btcSymbol, marketType: input.config.marketType, priceSource: input.config.priceSource }),
        exchangeB.getPriceSnapshot({ symbol: input.config.btcSymbol, marketType: input.config.marketType, priceSource: input.config.priceSource })
      ]);
      console.log('Price snapshots fetched', {
        tick,
        exchangeA: priceA.exchangeId,
        exchangeAPriceUsd: priceA.priceUsd,
        exchangeB: priceB.exchangeId,
        exchangeBPriceUsd: priceB.priceUsd,
        priceSource: input.config.priceSource
      });

      const spread = calculateSpread({ exchangeA: priceA, exchangeB: priceB, thresholdUsd: input.config.minPriceDiffUsd });
      const signal = signalEngine.evaluate(spread);
      console.log('Spread snapshot', {
        tick,
        symbol: spread.symbol,
        exchangeA: spread.exchangeA,
        exchangeB: spread.exchangeB,
        absoluteDiffUsd: spread.absoluteDiffUsd,
        thresholdMatched: spread.thresholdMatched
      });
      if (signal) {
        console.warn('Trading signal created', {
          tick,
          symbol: signal.symbol,
          longExchange: signal.longExchange,
          shortExchange: signal.shortExchange,
          absoluteDiffUsd: signal.absoluteDiffUsd,
          thresholdUsd: signal.thresholdUsd,
          mode: input.config.botExecutionMode
        });
        await input.notifier.notifySignal(signal);
      }
      console.log('Monitoring tick completed', {
        tick,
        durationMs: Date.now() - tickStartedAt.getTime()
      });
    } catch (error) {
      console.error('Polling tick failed', error instanceof Error ? { tick, message: error.message } : { tick, error });
    }
    if (input.config.botRunOnce) break;
    await sleep(input.config.pricePollIntervalMs);
  }
}

let shuttingDown = false;
process.once('SIGINT', () => { shuttingDown = true; });
process.once('SIGTERM', () => { shuttingDown = true; });
function isShuttingDown() { return shuttingDown; }
