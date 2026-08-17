import { and, eq, gt, inArray } from 'drizzle-orm';
import { tradePreviews, tradeLegs, trades } from '@btc-arbitrage/db';
import type { getDb } from '@btc-arbitrage/db';
import type { OpenTradePreview, OpenTradeState, PreviewStore } from './open-trade.js';

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
      const inserted = await tx.insert(trades).values({ signalId: preview.signalId, symbol: preview.symbol, marketType: preview.marketType, priceSource: 'last', mode: 'live', status: 'executing_limit', longExchange: preview.longExchange, shortExchange: preview.shortExchange, leverage: 1, entrySpreadUsd: String(Number(preview.shortPriceUsd) - Number(preview.longPriceUsd)), createdAt: new Date(), updatedAt: new Date() });
      const tradeId = Number((inserted as unknown as { insertId?: number }).insertId ?? 0); if (!tradeId) throw new Error('Failed to create trade');
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
