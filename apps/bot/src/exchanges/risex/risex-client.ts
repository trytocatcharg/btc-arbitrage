import type { PriceSnapshot } from '@btc-arbitrage/domain';
import type { ExchangeAdapter, ExchangeMarket, PriceRequest } from '@btc-arbitrage/exchange-core';
import { normalizeSymbol } from '@btc-arbitrage/exchange-core';
import { extractPrice, extractTimestamp, findMarket, getMarketId } from '../market-normalization.js';
import { RisexHttpClient } from './risex-http-client.js';
import type { RisexConfig } from './risex.types.js';

export function createRisexAdapter(config: RisexConfig, http = new RisexHttpClient(config.apiBaseUrl)): ExchangeAdapter {
  return {
    id: 'risex',
    displayName: 'RISEx',
    capabilities: { nativeFetch: true, websocket: 'polling-only', orderPlacement: false },
    async getMarkets(): Promise<ExchangeMarket[]> {
      const payload = await http.get('/v1/markets');
      const market = findMarket(payload, 'BTCUSDT', 'perpetual');
      return [{ exchangeId: 'risex', normalizedSymbol: normalizeSymbol(String(market.symbol ?? market.name ?? 'BTCUSDT')), externalMarketId: getMarketId(market), marketType: 'perpetual', supportsPriceSources: ['mark', 'index', 'last'], raw: market }];
    },
    async getPriceSnapshot(input: PriceRequest): Promise<PriceSnapshot> {
      const payload = await http.get('/v1/markets');
      const market = findMarket(payload, input.symbol, input.marketType);
      return {
        exchangeId: 'risex',
        symbol: input.symbol,
        externalMarketId: getMarketId(market),
        marketType: input.marketType,
        priceSource: input.priceSource,
        priceUsd: extractPrice(market, input.priceSource),
        exchangeTimestamp: normalizeRisexTimestamp(extractTimestamp(market)),
        receivedAt: new Date(),
        raw: market
      };
    },
    async createOrder() {
      return {
        mode: 'dry-run',
        symbol: 'BTCUSDT',
        leverage: 0,
        status: 'blocked',
        guardrailReason: 'RISEx live order placement is out of scope; requires RISEX_TRADING_ENABLED=true and complete prebuilt signed permit payload.',
        createdAt: new Date()
      };
    }
  };
}

export function normalizeRisexTimestamp(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return normalizeRisexTimestamp(Number(value));
  if (typeof value === 'number' && Number.isFinite(value)) {
    // RISEx local spec says timestamps are nanoseconds unless endpoint says otherwise.
    if (value > 10_000_000_000_000) return new Date(Math.floor(value / 1_000_000));
    return new Date(value);
  }
  if (typeof value === 'string') {
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf())) return date;
  }
  return new Date();
}
