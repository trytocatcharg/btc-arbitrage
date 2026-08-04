import type { PriceSnapshot, PriceSource } from '@btc-arbitrage/domain';
import type { ExchangeAdapter, ExchangeMarket, PriceRequest } from '@btc-arbitrage/exchange-core';
import { normalizeSymbol } from '@btc-arbitrage/exchange-core';
import { findMarket, getMarketId } from '../market-normalization.js';
import { ArcusHttpClient } from './arcus-http-client.js';
import type { ArcusBboResponse, ArcusConfig, ArcusMarketInfo, ArcusPriceEntry, ArcusPricesResponse } from './arcus.types.js';

const DEFAULT_ARCUS_MARKET = 'BTC-USD';

export function createArcusAdapter(config: ArcusConfig, http = new ArcusHttpClient(config.apiBaseUrl, config.userAgent, config.apiKey)): ExchangeAdapter {
  return {
    id: 'arcus',
    displayName: 'Arcus',
    capabilities: { nativeFetch: true, websocket: 'polling-only', orderPlacement: false },
    async getMarkets(): Promise<ExchangeMarket[]> {
      const payload = await http.get('/v1/markets', { market: DEFAULT_ARCUS_MARKET });
      const market = findArcusMarket(payload, 'BTCUSDT');
      return [{
        exchangeId: 'arcus',
        normalizedSymbol: normalizeSymbol(String(market.marketDisplayName ?? DEFAULT_ARCUS_MARKET)),
        externalMarketId: getMarketId(market),
        marketType: 'perpetual',
        supportsPriceSources: ['mark', 'index', 'last'],
        raw: market
      }];
    },
    async getPriceSnapshot(input: PriceRequest): Promise<PriceSnapshot> {
      if (input.marketType !== 'perpetual') throw new Error('Arcus adapter only supports perpetual markets');
      const marketName = toArcusMarketName(input.symbol);
      const [pricePayload, marketPayload, bboPayload] = await Promise.all([
        http.get('/v1/prices'),
        input.priceSource === 'last' ? http.get('/v1/markets', { market: marketName }) : Promise.resolve(undefined),
        http.get(`/v1/bbo/${encodeURIComponent(marketName)}`)
      ]);
      const priceEntry = findArcusPriceEntry(pricePayload, marketName);
      const market = marketPayload ? findArcusMarket(marketPayload, input.symbol) : undefined;
      const bbo = asArcusBbo(bboPayload);

      return {
        exchangeId: 'arcus',
        symbol: input.symbol,
        externalMarketId: priceEntry.marketId,
        marketType: input.marketType,
        priceSource: input.priceSource,
        priceUsd: extractArcusPrice(priceEntry, input.priceSource, market),
        bidUsd: bbo.bestBid?.price,
        askUsd: bbo.bestAsk?.price,
        exchangeTimestamp: normalizeArcusTimestamp(bbo.timestamp),
        receivedAt: new Date(),
        raw: { price: priceEntry.raw, market, bbo }
      };
    },
    async createOrder() {
      return {
        mode: 'dry-run',
        symbol: 'BTCUSDT',
        leverage: 0,
        status: 'blocked',
        guardrailReason: 'Arcus live order placement is out of scope; requires ARCUS_TRADING_ENABLED=true and Ed25519 signed order payloads.',
        createdAt: new Date()
      };
    }
  };
}

export function toArcusMarketName(symbol: string): string {
  const normalized = normalizeSymbol(symbol);
  if (normalized.endsWith('USDT') || normalized.endsWith('USDC')) return `${normalized.slice(0, -4)}-USD`;
  if (normalized.endsWith('USD')) return `${normalized.slice(0, -3)}-USD`;
  return symbol.includes('-') ? symbol.toUpperCase() : symbol;
}

export function extractArcusPrice(priceEntry: ArcusPriceEntry, priceSource: PriceSource, market?: ArcusMarketInfo): string {
  const valueBySource: Record<PriceSource, unknown> = {
    mark: priceEntry.markPrice,
    index: priceEntry.oraclePrice,
    last: market?.lastTradePrice
  };
  const value = valueBySource[priceSource];
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`Arcus PRICE_SOURCE=${priceSource} is not present in market payload; refusing silent fallback`);
  }

  const asString = String(value);
  if (Number(asString) <= 0) {
    throw new Error(`Arcus PRICE_SOURCE=${priceSource} returned ${asString}; refusing silent fallback`);
  }
  return asString;
}

export function normalizeArcusTimestamp(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return normalizeArcusTimestamp(Number(value));
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Arcus BBO timestamps are epoch microseconds.
    if (value > 10_000_000_000_000) return new Date(Math.floor(value / 1_000));
    if (value > 10_000_000_000) return new Date(value);
    return new Date(value * 1000);
  }
  if (typeof value === 'string') {
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf())) return date;
  }
  return new Date();
}

function findArcusPriceEntry(payload: unknown, marketName: string): ArcusPriceEntry & { marketId: string; raw: ArcusPriceEntry } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Arcus prices response was not an object');
  }
  const prices = payload as ArcusPricesResponse;
  for (const [marketId, entry] of Object.entries(prices)) {
    if (normalizeSymbol(String(entry.marketDisplayName ?? '')) === normalizeSymbol(marketName)) {
      return { ...entry, marketId, raw: entry };
    }
  }
  throw new Error(`Arcus market ${marketName} was not found in prices response`);
}

function findArcusMarket(payload: unknown, symbol: string): ArcusMarketInfo {
  const market = findMarket(payload, symbol, 'perpetual') as ArcusMarketInfo;
  if (market.status && String(market.status).toUpperCase() !== 'ONLINE') {
    throw new Error(`Arcus market ${symbol} is not ONLINE`);
  }
  return market;
}

function asArcusBbo(payload: unknown): ArcusBboResponse {
  if (payload && typeof payload === 'object') return payload as ArcusBboResponse;
  return {};
}
