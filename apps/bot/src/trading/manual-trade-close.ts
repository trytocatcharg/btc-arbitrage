import { and, desc, eq, inArray } from "drizzle-orm";
import {
  trades,
  tradeLegs,
  tradePreviews,
  type getDb,
} from "@btc-arbitrage/db";
import type { ExchangeAdapter } from "@btc-arbitrage/exchange-core";
import { closeTradeBothLegs } from "./trade-close.js";
import { DbPreviewStore } from "./db-preview-store.js";
import { extractAffectedRows } from "../db-result.js";

/** Operator-initiated market close of an open/unhedged BTC spread trade —
 * the manual escape hatch behind the /trade "Close @ market" button
 * (gold-silver-decouple). Race-safe: claims the trade into 'closing'
 * with a conditional UPDATE before touching the exchange, so a
 * double-confirm can never close twice; the second claim finds the trade
 * already 'closing' and reports no-op. The close itself reuses
 * closeTradeBothLegs (TP/SL backstop cancel, reduce-only market closes,
 * flatness wait, leg/trade persistence with realized PnL, operator
 * notice) — the same primitive the stale-'closing' recovery sweep runs. */
export async function manualMarketCloseTrade(input: {
  db: Awaited<ReturnType<typeof getDb>>;
  registry: { get(id: string): ExchangeAdapter };
  notifier: { notifyUrgent: (text: string) => Promise<void> };
  tradeId: number;
}): Promise<void> {
  const { db, tradeId } = input;
  const notify = (text: string) => input.notifier.notifyUrgent(text);

  const trade = (
    await db.select().from(trades).where(eq(trades.id, tradeId)).limit(1)
  )[0];
  if (!trade) {
    await notify(`⚠️ Manual close: trade #${tradeId} no longer exists.`);
    return;
  }

  // Claim: only open/unhedged trades may enter 'closing' here. Anything
  // else (already closing/closed, still entering) means another owner got
  // there first — report and stop.
  const claim = await db
    .update(trades)
    .set({ status: "closing", updatedAt: new Date() })
    .where(
      and(
        eq(trades.id, tradeId),
        inArray(trades.status, ["open", "unhedged"]),
      ),
    );
  if (extractAffectedRows(claim) === 0) {
    await notify(
      `⚠️ Manual close of #${tradeId} skipped: trade is now ` +
        `'${trade.status}' (already closing/closed or not closeable).`,
    );
    return;
  }

  const legs = await db
    .select()
    .from(tradeLegs)
    .where(
      and(
        eq(tradeLegs.tradeId, tradeId),
        inArray(tradeLegs.status, ["open", "unhedged"]),
      ),
    );
  const tokenRow = (
    await db
      .select({ token: tradePreviews.token })
      .from(tradePreviews)
      .where(eq(tradePreviews.tradeId, tradeId))
      .orderBy(desc(tradePreviews.id))
  )[0];
  if (!tokenRow?.token) {
    console.error("Manual close aborted: no preview token", { tradeId });
    await notify(
      `🚨 Manual close of #${tradeId} aborted: no preview token found. ` +
        "The trade is marked 'closing' — use the stale-close recovery path.",
    );
    return;
  }
  if (legs.length === 0) {
    // Nothing left to close on the exchange (e.g. positions already flat);
    // settle the trade record directly.
    await new DbPreviewStore(db).transition(tokenRow.token, "closed", {
      closeReason: "manual_close",
    });
    return;
  }
  const quantity = legs[0]?.quantityBase ?? null;
  if (!quantity) {
    console.error("Manual close aborted: no leg quantity", { tradeId });
    await notify(
      `🚨 Manual close of #${tradeId} aborted: open leg has no quantity.`,
    );
    return;
  }

  await closeTradeBothLegs({
    store: new DbPreviewStore(db),
    registry: input.registry,
    token: tokenRow.token,
    label: `#${tradeId}`,
    symbol: trade.symbol,
    longExchange: trade.longExchange,
    shortExchange: trade.shortExchange,
    legs: legs.map((leg) => ({
      exchangeId: leg.exchangeId,
      side: leg.side,
      quantityBase: leg.quantityBase ?? quantity,
      entryPriceUsd: leg.entryPriceUsd ?? null,
      raw: leg.raw,
    })),
    reason: "manual_close",
    notify,
  });
}
