import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import { tradePreviews, tradeLegs, trades } from '@btc-arbitrage/db';
import type { getDb } from '@btc-arbitrage/db';
import type { OpenTradePreview, OpenTradeState, PreviewStore } from './open-trade.js';
import { JsonFileLogger } from '../logging/json-file-logger.js';

const dbPreviewLogger = new JsonFileLogger('logs/open-trade.jsonl');

export class DbPreviewStore implements PreviewStore {
  constructor(private readonly db: Awaited<ReturnType<typeof getDb>>) {}
  async createPreview(preview: OpenTradePreview): Promise<void> { await this.db.insert(tradePreviews).values({ signalId: preview.signalId, token: preview.token, status: 'awaiting_confirmation', expiresAt: preview.expiresAt, payload: preview, createdAt: new Date(), updatedAt: new Date() }); }
  async consumePreview(token: string, now: Date): Promise<OpenTradePreview | null> {
    const rows = await this.db.select().from(tradePreviews).where(and(eq(tradePreviews.token, token), eq(tradePreviews.status, 'awaiting_confirmation'), gt(tradePreviews.expiresAt, now)));
    const row = rows[0]; if (!row) return null;
    const changed = await this.db.update(tradePreviews).set({ status: 'executing_limit', consumedAt: now, updatedAt: now }).where(and(eq(tradePreviews.id, row.id), eq(tradePreviews.status, 'awaiting_confirmation')));
    if (Number((changed as unknown as { affectedRows?: number }).affectedRows ?? 1) !== 1) return null;
    return row.payload as unknown as OpenTradePreview;
  }
  async startExecution(preview: OpenTradePreview): Promise<void> {
    await this.db.transaction(async (tx) => {
      const createdAt = new Date();
      const row = {
        signalId: preview.signalId,
        symbol: preview.symbol,
        marketType: preview.marketType,
        priceSource: 'last' as const,
        mode: 'live' as const,
        status: 'executing_limit' as const,
        longExchange: preview.longExchange,
        shortExchange: preview.shortExchange,
        leverage: 1,
        entrySpreadUsd: String(Number(preview.shortPriceUsd) - Number(preview.longPriceUsd)),
        createdAt,
        updatedAt: createdAt
      };
      const inserted = await tx.insert(trades).values(row);
      let tradeId = Number((inserted as unknown as { insertId?: number }).insertId ?? 0);
      if (!tradeId) {
        const fallback = await tx.select({ id: trades.id }).from(trades).where(and(
          eq(trades.signalId, row.signalId),
          eq(trades.symbol, row.symbol),
          eq(trades.marketType, row.marketType),
          eq(trades.priceSource, row.priceSource),
          eq(trades.mode, row.mode),
          eq(trades.status, row.status),
          eq(trades.longExchange, row.longExchange),
          eq(trades.shortExchange, row.shortExchange),
          eq(trades.leverage, row.leverage),
          eq(trades.entrySpreadUsd, row.entrySpreadUsd)
        )).orderBy(desc(trades.id));
        tradeId = Number(fallback[0]?.id ?? 0);
      }
      if (!tradeId) {
        await dbPreviewLogger.write({ timestamp: new Date().toISOString(), event: 'open_trade_db_trade_create_failed', token: preview.token, signalId: preview.signalId, symbol: preview.symbol, longExchange: preview.longExchange, shortExchange: preview.shortExchange, entrySpreadUsd: row.entrySpreadUsd });
        throw new Error('Failed to create trade');
      }
      await dbPreviewLogger.write({ timestamp: new Date().toISOString(), event: 'open_trade_db_trade_created', token: preview.token, signalId: preview.signalId, tradeId });
      await tx.insert(tradeLegs).values([{ tradeId, exchangeId: preview.longExchange, side: 'long', status: 'planned', quantityBase: preview.quantityBase }, { tradeId, exchangeId: preview.shortExchange, side: 'short', status: 'planned', quantityBase: preview.quantityBase }]);
      await tx.update(tradePreviews).set({ tradeId, updatedAt: new Date() }).where(eq(tradePreviews.token, preview.token));
    });
  }
  async claimRollback(token: string): Promise<boolean> {
    const result = await this.db.update(tradePreviews).set({ status: 'rolling_back', updatedAt: new Date() }).where(and(eq(tradePreviews.token, token), inArray(tradePreviews.status, ['executing_limit', 'hedging', 'protecting'])));
    return Number((result as unknown as { affectedRows?: number }).affectedRows ?? 0) === 1;
  }
  async transition(token: string, state: OpenTradeState, _details?: Record<string, unknown>): Promise<void> { await this.db.update(tradePreviews).set({ status: state, updatedAt: new Date() }).where(eq(tradePreviews.token, token)); }
}
