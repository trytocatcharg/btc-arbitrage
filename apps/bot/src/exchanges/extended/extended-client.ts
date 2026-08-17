import { ExecutionMode, type PriceSnapshot } from '@btc-arbitrage/domain';
import type { ExchangeAdapter, ExchangeMarket, PriceRequest } from '@btc-arbitrage/exchange-core';
import { normalizeSymbol } from '@btc-arbitrage/exchange-core';
import { extractPrice, extractTimestamp, findMarket, getMarketId } from '../market-normalization.js';
import { ExtendedHttpClient } from './extended-http-client.js';
import type { ExtendedConfig } from './extended.types.js';
import { createExtendedExecutionAdapter } from './extended-execution-adapter.js';

export function createExtendedAdapter(config: ExtendedConfig, http = new ExtendedHttpClient(config.apiBaseUrl, config.userAgent, config.apiKey)): ExchangeAdapter {
  return {
    id: 'extended',
    displayName: 'Extended',
    capabilities: { nativeFetch: true, websocket: 'polling-only', orderPlacement: config.tradingEnabled },
    execution: createExtendedExecutionAdapter(config, http),
    async getMarkets(): Promise<ExchangeMarket[]> {
      const payload = await http.get('/api/v1/info/markets');
      const market = findMarket(payload, 'BTCUSDT', 'perpetual');
      return [{ exchangeId: 'extended', normalizedSymbol: normalizeSymbol(String(market.symbol ?? market.name ?? 'BTCUSDT')), externalMarketId: getMarketId(market), marketType: 'perpetual', supportsPriceSources: ['mark', 'index', 'last'], raw: market }];
    },
    async getPriceSnapshot(input: PriceRequest): Promise<PriceSnapshot> {
      const payload = await http.get('/api/v1/info/markets');
      const market = findMarket(payload, input.symbol, input.marketType);
      return {
        exchangeId: 'extended',
        symbol: input.symbol,
        externalMarketId: getMarketId(market),
        marketType: input.marketType,
        priceSource: input.priceSource,
        priceUsd: extractPrice(market, input.priceSource),
        bidUsd: extractOptionalPrice(market, ['bid', 'bidPrice', 'bestBid']),
        askUsd: extractOptionalPrice(market, ['ask', 'askPrice', 'bestAsk']),
        exchangeTimestamp: normalizeExtendedTimestamp(extractTimestamp(market)),
        receivedAt: new Date(),
        raw: market
      };
    },
    async createOrder() {
      return {
        mode: ExecutionMode.DryRun,
        symbol: 'BTCUSDT',
        leverage: 0,
        status: 'blocked',
        guardrailReason: 'Extended live order placement is out of scope; requires EXTENDED_TRADING_ENABLED=true plus complete Stark-signed payload.',
        createdAt: new Date()
      };
    }
  };
}

function extractOptionalPrice(market: Record<string, unknown>, keys: string[]): string | undefined {
  const stats = (market.marketStats && typeof market.marketStats === 'object' ? market.marketStats : market) as Record<string, unknown>;
  for (const key of keys) { const value = stats[key]; if (typeof value === 'string' || typeof value === 'number') return String(value); }
  return undefined;
}

export function normalizeExtendedTimestamp(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value);
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && /^\d+$/.test(value)) return new Date(numeric);
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf())) return date;
  }
  return new Date();
}
