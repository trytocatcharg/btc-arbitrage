import type { PriceSource } from '@btc-arbitrage/domain';
import type { MarketType } from '@btc-arbitrage/domain';
import { normalizeSymbol } from '@btc-arbitrage/exchange-core';

export function asArrayPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    for (const key of ['data', 'markets', 'result', 'items']) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
    for (const key of ['data', 'result']) {
      const nested = record[key];
      if (nested && typeof nested === 'object') {
        const nestedArray = asArrayPayload(nested);
        if (nestedArray.length > 0) return nestedArray;
      }
    }
  }
  return [];
}

export function findMarket(payload: unknown, symbol: string, marketType?: MarketType): Record<string, unknown> {
  const target = normalizeSymbol(symbol);
  const targetBase = extractBaseAsset(target);
  let baseAssetMatch: Record<string, unknown> | undefined;

  for (const item of asArrayPayload(payload)) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (marketType && !matchesMarketType(record, marketType)) continue;
    const candidates = collectMarketCandidates(record);
    if (candidates.some((candidate) => candidate === target)) return record;
    if (candidates.some((candidate) => candidate === targetBase || candidate.startsWith(targetBase))) {
      baseAssetMatch ??= record;
    }
  }
  if (baseAssetMatch) return baseAssetMatch;
  throw new Error(`Market ${symbol} was not found in exchange markets response`);
}

export function getMarketId(market: Record<string, unknown>): string {
  const value = market.market_id ?? market.marketId ?? market.id ?? market.name ?? market.symbol ?? market.market;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  throw new Error('Market response did not include a usable market id');
}

export function extractPrice(market: Record<string, unknown>, priceSource: PriceSource): string {
  const keysBySource: Record<PriceSource, string[]> = {
    mark: ['mark_price', 'markPrice', 'mark', 'mark_price_usd', 'markPriceUsd'],
    index: ['index_price', 'indexPrice', 'index', 'index_price_usd', 'indexPriceUsd'],
    last: ['last_price', 'lastPrice', 'last', 'price', 'last_price_usd', 'lastPriceUsd']
  };
  for (const source of nestedRecords(market)) {
    for (const key of keysBySource[priceSource]) {
      const value = source[key];
      if (typeof value === 'string' || typeof value === 'number') return String(value);
    }
  }
  throw new Error(`Requested PRICE_SOURCE=${priceSource} is not present in market payload; refusing silent fallback`);
}

export function extractTimestamp(market: Record<string, unknown>): unknown {
  for (const source of nestedRecords(market)) {
    const value = source.timestamp ?? source.updated_at ?? source.updatedAt ?? source.time ?? source.created_at ?? source.createdAt;
    if (value !== undefined) return value;
  }
  return undefined;
}

function collectMarketCandidates(record: Record<string, unknown>): string[] {
  const directValues = [
    record.symbol,
    record.market,
    record.market_id,
    record.marketId,
    record.name,
    record.id,
    record.display_name,
    record.displayName,
    record.underlying,
    record.base_asset_symbol,
    record.baseAssetSymbol,
    record.assetName,
    record.asset,
    record.baseAsset
  ];
  const config = record.config;
  const configValues = config && typeof config === 'object'
    ? [
        (config as Record<string, unknown>).name,
        (config as Record<string, unknown>).symbol,
        (config as Record<string, unknown>).market,
        (config as Record<string, unknown>).base_asset_symbol,
        (config as Record<string, unknown>).baseAssetSymbol,
        (config as Record<string, unknown>).underlying
      ]
    : [];

  return [...directValues, ...configValues]
    .filter((value): value is string | number => typeof value === 'string' || typeof value === 'number')
    .map((value) => normalizeSymbol(String(value)));
}

function matchesMarketType(record: Record<string, unknown>, marketType: MarketType): boolean {
  const rawType = record.type ?? record.market_type ?? record.marketType;
  if (rawType === undefined) return true;
  const normalized = String(rawType).toLowerCase();
  if (marketType === 'perpetual') return normalized === 'perpetual' || normalized === 'perp';
  return normalized === 'futures' || normalized === 'future';
}

function nestedRecords(record: Record<string, unknown>): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [record];
  for (const key of ['marketStats', 'stats', 'ticker', 'priceStats']) {
    const value = record[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) records.push(value as Record<string, unknown>);
  }
  return records;
}

function extractBaseAsset(normalizedSymbol: string): string {
  for (const quote of ['USDT', 'USDC', 'USD']) {
    if (normalizedSymbol.endsWith(quote) && normalizedSymbol.length > quote.length) {
      return normalizedSymbol.slice(0, -quote.length);
    }
  }
  return normalizedSymbol;
}
