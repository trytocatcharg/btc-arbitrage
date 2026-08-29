import { and, eq, inArray, isNull } from 'drizzle-orm';
import { activeTradeStatuses, tradeLegs, trades, type getDb } from '@btc-arbitrage/db';
import type { ExchangeAdapter } from '@btc-arbitrage/exchange-core';
import { formatDecimal, parseDecimal } from '@btc-arbitrage/domain';
import { shouldNotifyLegClosure } from './trade-guards.js';

export async function monitorTrades(input: { db: Awaited<ReturnType<typeof getDb>>; registry: { get(id: string): ExchangeAdapter }; notify: (text: string) => Promise<void> }): Promise<void> {
  const rows = await input.db.select().from(tradeLegs).innerJoin(trades, eq(tradeLegs.tradeId, trades.id)).where(
    and(inArray(trades.status, [...activeTradeStatuses]), inArray(tradeLegs.status, ['open', 'unhedged']), isNull(tradeLegs.closureNotifiedAt))
  );

  for (const row of rows) {
    try {
      const adapter = input.registry.get(row.trade_legs.exchangeId).execution;
      if (!adapter) continue;

      const position = await adapter.getPosition({ symbol: row.trades.symbol, side: row.trade_legs.side });
      const positionClosed = position === null || position.status === 'closed';
      if (!positionClosed || !shouldNotifyLegClosure({ positionClosed, alreadyNotified: row.trade_legs.closureNotifiedAt != null })) continue;

      const siblingSide = row.trade_legs.side === 'long' ? 'short' : 'long';
      const siblingRows = await input.db.select().from(tradeLegs).where(and(eq(tradeLegs.tradeId, row.trade_legs.tradeId), eq(tradeLegs.side, siblingSide)));
      const sibling = siblingRows[0];

      await input.db.transaction(async tx => {
        const legUpdates: Partial<typeof tradeLegs.$inferInsert> = {
          status: 'closed',
          closeReason: position?.closeReason ?? 'unknown',
          closedAt: new Date(),
          closureNotifiedAt: new Date(),
        };
        if (position?.exitPriceUsd != null) legUpdates.exitPriceUsd = position.exitPriceUsd;
        if (position?.realizedPnlUsd != null) legUpdates.realizedPnlUsd = position.realizedPnlUsd;
        await tx.update(tradeLegs).set(legUpdates).where(and(eq(tradeLegs.id, row.trade_legs.id), isNull(tradeLegs.closureNotifiedAt)));

        const siblingAlreadyClosed = sibling?.status === 'closed';
        if (siblingAlreadyClosed) {
          const allLegs = await tx.select().from(tradeLegs).where(eq(tradeLegs.tradeId, row.trades.id));
          const totalRealizedPnl = allLegs.reduce((sum, leg) => {
            if (leg.realizedPnlUsd != null) return sum + parseDecimal(leg.realizedPnlUsd);
            if (leg.exitPriceUsd != null && leg.entryPriceUsd != null && leg.quantityBase != null) {
              const sideMul = leg.side === 'long' ? 1 : -1;
              return sum + sideMul * (parseDecimal(leg.exitPriceUsd) - parseDecimal(leg.entryPriceUsd)) * parseDecimal(leg.quantityBase);
            }
            return sum;
          }, 0);
          await tx.update(trades).set({
            status: 'closed',
            realizedPnlUsd: formatDecimal(totalRealizedPnl, 8),
            closedAt: new Date(),
            updatedAt: new Date(),
          }).where(eq(trades.id, row.trades.id));
        } else {
          await tx.update(trades).set({ status: 'unhedged', updatedAt: new Date() }).where(eq(trades.id, row.trades.id));
        }
      });

      const message = sibling?.status === 'closed'
        ? `✅ Trade #${row.trades.id}: both legs closed.`
        : `🚨 Trade #${row.trades.id}: ${row.trade_legs.side.toUpperCase()} ${row.trade_legs.exchangeId} closed (${position?.closeReason ?? 'unknown'}). Remaining ${sibling?.side?.toUpperCase() ?? 'UNKNOWN'} ${sibling?.exchangeId ?? 'unknown'} is UNHEDGED.`;
      await input.notify(message);
    } catch (error) { console.warn('Trade monitoring skipped adapter failure', error instanceof Error ? error.message : error); }
  }
}
