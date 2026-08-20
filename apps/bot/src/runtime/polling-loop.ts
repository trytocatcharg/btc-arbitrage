import { calculateSpread } from '@btc-arbitrage/domain';
import { sleep } from '@btc-arbitrage/shared';
import type { BotConfig } from '@btc-arbitrage/config';
import type { ExchangeAdapter } from '@btc-arbitrage/exchange-core';
import { SignalEngine } from '../signals/signal-engine.js';
import type { Notifier } from '../notifications/notifier.js';
import type { getDb } from '@btc-arbitrage/db';
import { signals, activeTradeStatuses, trades } from '@btc-arbitrage/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { monitorTrades } from '../trading/trade-monitor.js';
import { shouldSuppressSignalForActiveTrades } from '../trading/trade-guards.js';

export interface ExchangeRegistry {
  get(id: string): ExchangeAdapter;
}

export interface CommandPoller {
  pollOnce(): Promise<void>;
}

export async function runPollingLoop(input: { config: BotConfig; registry: ExchangeRegistry; notifier: Notifier; db: Awaited<ReturnType<typeof getDb>>; commandPoller?: CommandPoller }): Promise<void> {
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
      try {
        await input.commandPoller?.pollOnce();
      } catch (error) {
        console.error('Telegram command polling failed', error instanceof Error ? { tick, message: error.message } : { tick, error });
      }
      await monitorTrades({ db: input.db, registry: input.registry, notify: (text) => input.notifier.notifyUrgent(text) });

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
        const active = await input.db.select({ id: trades.id }).from(trades).where(inArray(trades.status, [...activeTradeStatuses])).orderBy(desc(trades.id));
        if (shouldSuppressSignalForActiveTrades(active.map((trade) => trade.id))) {
          console.log('Signal suppressed because an active or unhedged trade exists', { tick, activeTradeId: active[0]?.id });
          continue;
        }
        const signalRow = { spreadId: signal.spreadId ? Number(signal.spreadId) : null, longExchange: signal.longExchange, shortExchange: signal.shortExchange, source: signal.priceSource, leverage: signal.leverage, thresholdUsd: signal.thresholdUsd, observedDiffUsd: signal.absoluteDiffUsd, reason: signal.reason, status: 'notified', createdAt: signal.createdAt };
        const created = await input.db.insert(signals).values(signalRow);
        const signalId = await resolveInsertedSignalId(input.db, created, signalRow);
        console.warn('Trading signal created', {
          tick,
          signalId,
          symbol: signal.symbol,
          longExchange: signal.longExchange,
          shortExchange: signal.shortExchange,
          absoluteDiffUsd: signal.absoluteDiffUsd,
          thresholdUsd: signal.thresholdUsd,
          mode: input.config.botExecutionMode
        });
        await input.notifier.notifySignal({ ...signal, id: signalId ? String(signalId) : undefined });
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

async function resolveInsertedSignalId(
  db: Awaited<ReturnType<typeof getDb>>,
  created: unknown,
  row: {
    spreadId: number | null;
    longExchange: string;
    shortExchange: string;
    source: string;
    leverage: number;
    thresholdUsd: string;
    observedDiffUsd: string;
    reason: string;
    status: string;
    createdAt: Date;
  }
): Promise<number> {
  const insertId = Number((created as { insertId?: number }).insertId ?? 0);
  if (insertId > 0) return insertId;

  const inserted = await db.select({ id: signals.id }).from(signals).where(and(
    eq(signals.longExchange, row.longExchange),
    eq(signals.shortExchange, row.shortExchange),
    eq(signals.source, row.source),
    eq(signals.leverage, row.leverage),
    eq(signals.thresholdUsd, row.thresholdUsd),
    eq(signals.observedDiffUsd, row.observedDiffUsd),
    eq(signals.reason, row.reason),
    eq(signals.status, row.status)
  )).orderBy(desc(signals.id));

  return Number(inserted[0]?.id ?? 0);
}

let shuttingDown = false;
process.once('SIGINT', () => { shuttingDown = true; });
process.once('SIGTERM', () => { shuttingDown = true; });
function isShuttingDown() { return shuttingDown; }
