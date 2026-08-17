import { desc, inArray } from 'drizzle-orm';
import { getDb, tradeLegs, trades, openTradeStatuses } from '@btc-arbitrage/db';
import type { ExchangeAdapter } from '@btc-arbitrage/exchange-core';
import type { MarketType, PriceSource } from '@btc-arbitrage/domain';

type BotDatabase = Awaited<ReturnType<typeof getDb>>;
type TradeRow = typeof trades.$inferSelect;
type TradeLegRow = typeof tradeLegs.$inferSelect;

export interface ExchangeRegistryLike {
  get(id: string): ExchangeAdapter;
}

export interface TradeSummaryDependencies {
  db: BotDatabase;
  registry: ExchangeRegistryLike;
}

interface ResolvedTradeSummary {
  id: number;
  status: string;
  symbol: string;
  marketType: MarketType;
  priceSource: PriceSource;
  createdAt: Date;
  openedAt: Date | null;
  updatedAt: Date;
  entrySpreadUsd: number | null;
  liveSpreadUsd: number | null;
  totalEstimatedPnlUsd: number | null;
  longLeg: ResolvedLegSummary;
  shortLeg: ResolvedLegSummary;
  notes: string[];
}

interface ResolvedLegSummary {
  exchangeId: string;
  status: string;
  side: 'long' | 'short';
  entryPriceUsd: number | null;
  quantityBase: number | null;
  currentPriceUsd: number | null;
  estimatedPnlUsd: number | null;
  quoteError?: string;
}

interface QuoteSnapshot {
  priceUsd: number;
}

export async function buildTradeSummaryMessage(deps: TradeSummaryDependencies): Promise<string> {
  const activeTrades = await loadActiveTrades(deps.db);
  if (activeTrades.length === 0) {
    return '📭 No active trades found.';
  }

  const legsByTradeId = await loadTradeLegsByTradeId(deps.db, activeTrades.map((trade) => trade.id));
  const quoteCache = new Map<string, Promise<QuoteSnapshot | QuoteError>>();

  const summaries = await Promise.all(
    activeTrades.map(async (trade) => {
      const legs = legsByTradeId.get(trade.id) ?? [];
      return buildTradeSummary(trade, legs, deps.registry, quoteCache);
    })
  );

  return formatTradeSummaryMessage(summaries);
}

async function loadActiveTrades(db: BotDatabase): Promise<TradeRow[]> {
  return db
    .select()
    .from(trades)
    .where(inArray(trades.status, [...openTradeStatuses]))
    .orderBy(desc(trades.openedAt), desc(trades.createdAt));
}

async function loadTradeLegsByTradeId(db: BotDatabase, tradeIds: number[]): Promise<Map<number, TradeLegRow[]>> {
  const byTradeId = new Map<number, TradeLegRow[]>();
  if (tradeIds.length === 0) return byTradeId;

  const rows = await db.select().from(tradeLegs).where(inArray(tradeLegs.tradeId, tradeIds));
  for (const row of rows) {
    const current = byTradeId.get(row.tradeId) ?? [];
    current.push(row);
    byTradeId.set(row.tradeId, current);
  }
  return byTradeId;
}

async function buildTradeSummary(
  trade: TradeRow,
  tradeLegRows: TradeLegRow[],
  registry: ExchangeRegistryLike,
  quoteCache: Map<string, Promise<QuoteSnapshot | QuoteError>>
): Promise<ResolvedTradeSummary> {
  const longLegRow = tradeLegRows.find((leg) => leg.side === 'long');
  const shortLegRow = tradeLegRows.find((leg) => leg.side === 'short');

  const [longQuote, shortQuote] = await Promise.all([
    longLegRow ? fetchCurrentQuote(registry, trade, longLegRow.exchangeId, quoteCache) : Promise.resolve<QuoteError>({ error: 'Missing long leg row' }),
    shortLegRow ? fetchCurrentQuote(registry, trade, shortLegRow.exchangeId, quoteCache) : Promise.resolve<QuoteError>({ error: 'Missing short leg row' })
  ]);

  const longLeg = resolveLegSummary(longLegRow, longQuote, 'long');
  const shortLeg = resolveLegSummary(shortLegRow, shortQuote, 'short');
  const entrySpreadUsd = resolveEntrySpreadUsd(trade, longLegRow, shortLegRow);
  const liveSpreadUsd = longLeg.currentPriceUsd != null && shortLeg.currentPriceUsd != null
    ? shortLeg.currentPriceUsd - longLeg.currentPriceUsd
    : null;

  const totalEstimatedPnlUsd =
    longLeg.estimatedPnlUsd != null && shortLeg.estimatedPnlUsd != null
      ? longLeg.estimatedPnlUsd + shortLeg.estimatedPnlUsd
      : toNumber(trade.unrealizedPnlUsd);

  const notes: string[] = [];
  if (!longLegRow) notes.push('Long leg row missing in DB.');
  if (!shortLegRow) notes.push('Short leg row missing in DB.');
  if (longLeg.quoteError) notes.push(`Long quote unavailable: ${longLeg.quoteError}`);
  if (shortLeg.quoteError) notes.push(`Short quote unavailable: ${shortLeg.quoteError}`);

  return {
    id: trade.id,
    status: trade.status,
    symbol: trade.symbol,
    marketType: trade.marketType as MarketType,
    priceSource: trade.priceSource as PriceSource,
    createdAt: trade.createdAt,
    openedAt: trade.openedAt ?? null,
    updatedAt: trade.updatedAt,
    entrySpreadUsd,
    liveSpreadUsd,
    totalEstimatedPnlUsd,
    longLeg,
    shortLeg,
    notes
  };
}

async function fetchCurrentQuote(
  registry: ExchangeRegistryLike,
  trade: TradeRow,
  exchangeId: string,
  quoteCache: Map<string, Promise<QuoteSnapshot | QuoteError>>
): Promise<QuoteSnapshot | QuoteError> {
  const cacheKey = `${exchangeId}|${trade.symbol}|${trade.marketType}|${trade.priceSource}`;
  const cached = quoteCache.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    try {
      const adapter = registry.get(exchangeId);
      const snapshot = await adapter.getPriceSnapshot({
        symbol: trade.symbol,
        marketType: trade.marketType as MarketType,
        priceSource: trade.priceSource as PriceSource
      });
      const price = toNumber(snapshot.priceUsd);
      if (price == null) {
        return { error: `Invalid price ${snapshot.priceUsd}` } satisfies QuoteError;
      }
      return { priceUsd: price } satisfies QuoteSnapshot;
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Unknown quote error' } satisfies QuoteError;
    }
  })();

  quoteCache.set(cacheKey, promise);
  return promise;
}

function resolveLegSummary(leg: TradeLegRow | undefined, quote: QuoteSnapshot | QuoteError, side: 'long' | 'short'): ResolvedLegSummary {
  const entryPriceUsd = leg ? toNumber(leg.entryPriceUsd) : null;
  const quantityBase = resolveQuantityBase(leg);
  const currentPriceUsd = 'priceUsd' in quote ? quote.priceUsd : null;
  const estimatedPnlUsd = entryPriceUsd != null && quantityBase != null && currentPriceUsd != null
    ? side === 'long'
      ? (currentPriceUsd - entryPriceUsd) * quantityBase
      : (entryPriceUsd - currentPriceUsd) * quantityBase
    : null;

  return {
    exchangeId: leg?.exchangeId ?? 'unknown',
    status: leg?.status ?? 'missing',
    side,
    entryPriceUsd,
    quantityBase,
    currentPriceUsd,
    estimatedPnlUsd,
    quoteError: 'error' in quote ? quote.error : undefined
  };
}

function resolveQuantityBase(leg: TradeLegRow | undefined): number | null {
  if (!leg) return null;
  const explicitQuantity = toNumber(leg.quantityBase);
  if (explicitQuantity != null) return explicitQuantity;

  const quantityUsd = toNumber(leg.quantityUsd);
  const entryPrice = toNumber(leg.entryPriceUsd);
  if (quantityUsd != null && entryPrice != null && entryPrice > 0) {
    return quantityUsd / entryPrice;
  }
  return null;
}

function resolveEntrySpreadUsd(trade: TradeRow, longLeg: TradeLegRow | undefined, shortLeg: TradeLegRow | undefined): number | null {
  const storedEntrySpread = toNumber(trade.entrySpreadUsd);
  if (storedEntrySpread != null) return storedEntrySpread;

  const longEntry = toNumber(longLeg?.entryPriceUsd);
  const shortEntry = toNumber(shortLeg?.entryPriceUsd);
  if (longEntry == null || shortEntry == null) return null;
  return shortEntry - longEntry;
}

function formatTradeSummaryMessage(summaries: ResolvedTradeSummary[]): string {
  const lines: string[] = ['📊 Active trade summary'];

  for (const summary of summaries) {
    lines.push('');
    lines.push(`Trade #${summary.id} · ${summary.symbol} · ${summary.status}`);
    lines.push(`Market: ${summary.marketType} · Source: ${summary.priceSource}`);
    lines.push(`Created: ${formatDate(summary.createdAt)}${summary.openedAt ? ` · Opened: ${formatDate(summary.openedAt)}` : ''}`);

    if (summary.entrySpreadUsd != null) {
      lines.push(`Entry spread: ${formatSignedUsd(summary.entrySpreadUsd)}`);
    }
    if (summary.liveSpreadUsd != null) {
      lines.push(`Live spread: ${formatSignedUsd(summary.liveSpreadUsd)}`);
    }
    if (summary.totalEstimatedPnlUsd != null) {
      lines.push(`Estimated PnL: ${formatSignedUsd(summary.totalEstimatedPnlUsd)}`);
    }

    lines.push('');
    lines.push(formatLegSummary(summary.longLeg));
    lines.push(formatLegSummary(summary.shortLeg));

    if (summary.notes.length > 0) {
      lines.push('');
      for (const note of summary.notes) {
        lines.push(`• ${note}`);
      }
    }
  }

  return lines.join('\n');
}

function formatLegSummary(leg: ResolvedLegSummary): string {
  const label = leg.side.toUpperCase();
  const lines = [
    `${label} ${leg.exchangeId}`,
    `Status: ${leg.status}`,
    `Entry: ${formatUsd(leg.entryPriceUsd)}`,
    `Current: ${formatUsd(leg.currentPriceUsd)}`
  ];

  if (leg.quantityBase != null) {
    lines.push(`Qty: ${formatQty(leg.quantityBase)}`);
  }

  lines.push(`Leg PnL: ${formatSignedUsd(leg.estimatedPnlUsd)}`);
  if (leg.quoteError) {
    lines.push(`Quote error: ${leg.quoteError}`);
  }

  return lines.join('\n');
}

function formatDate(value: Date): string {
  return value.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z');
}

function formatUsd(value: number | null): string {
  if (value == null) return 'n/a';
  return `$${value.toFixed(2)}`;
}

function formatQty(value: number): string {
  return value.toFixed(8).replace(/\.?0+$/, '');
}

function formatSignedUsd(value: number | null): string {
  if (value == null) return 'n/a';
  const prefix = value >= 0 ? '+' : '-';
  return `${prefix}$${Math.abs(value).toFixed(2)}`;
}

function toNumber(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

interface QuoteError {
  error: string;
}
