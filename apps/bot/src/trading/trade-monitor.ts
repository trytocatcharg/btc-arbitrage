import { and, eq, inArray, isNull } from 'drizzle-orm';
import { activeTradeStatuses, tradeLegs, trades, type getDb } from '@btc-arbitrage/db';
import type { ExchangeAdapter } from '@btc-arbitrage/exchange-core';
import { shouldNotifyLegClosure } from './trade-guards.js';

export async function monitorTrades(input: { db: Awaited<ReturnType<typeof getDb>>; registry: { get(id: string): ExchangeAdapter }; notify: (text: string) => Promise<void> }): Promise<void> {
  const legs = await input.db.select().from(tradeLegs).innerJoin(trades, eq(tradeLegs.tradeId, trades.id)).where(and(inArray(trades.status, [...activeTradeStatuses]), inArray(tradeLegs.status, ['open', 'unhedged']), isNull(tradeLegs.closureNotifiedAt)));
  for (const row of legs) {
    try {
      const position = await input.registry.get(row.trade_legs.exchangeId).execution?.getPosition({ symbol: row.trades.symbol, side: row.trade_legs.side });
      if (!position || !shouldNotifyLegClosure({ positionClosed: position.status === 'closed', alreadyNotified: row.trade_legs.closureNotifiedAt != null })) continue;
      const remaining = await input.db.select().from(tradeLegs).where(and(eq(tradeLegs.tradeId, row.trade_legs.tradeId), eq(tradeLegs.side, row.trade_legs.side === 'long' ? 'short' : 'long')));
      await input.db.transaction(async tx => { await tx.update(tradeLegs).set({ status: 'closed', closeReason: position.closeReason ?? 'unknown', closedAt: new Date(), closureNotifiedAt: new Date() }).where(and(eq(tradeLegs.id, row.trade_legs.id), isNull(tradeLegs.closureNotifiedAt))); await tx.update(trades).set({ status: 'unhedged', updatedAt: new Date() }).where(eq(trades.id, row.trades.id)); });
      const other = remaining[0]; await input.notify(`🚨 Trade #${row.trades.id}: ${row.trade_legs.side.toUpperCase()} ${row.trade_legs.exchangeId} closed (${position.closeReason ?? 'unknown'}). Remaining ${other?.side?.toUpperCase() ?? 'UNKNOWN'} ${other?.exchangeId ?? 'unknown'} is UNHEDGED.`);
    } catch (error) { console.warn('Trade monitoring skipped adapter failure', error instanceof Error ? error.message : error); }
  }
}
