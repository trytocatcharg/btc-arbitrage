import { and, desc, eq, inArray, lt } from "drizzle-orm";
import {
  trades,
  tradeLegs,
  tradePreviews,
  type getDb,
} from "@btc-arbitrage/db";
import type { ExchangeAdapter } from "@btc-arbitrage/exchange-core";
import { closeTradeBothLegs } from "./trade-close.js";
import { DbPreviewStore } from "./db-preview-store.js";

/** Stale-'closing' recovery monitor. A trade claimed into 'closing'
 * whose close died mid-flight (process restart, unhandled error before
 * persist) would otherwise stay 'closing' forever, suppressing signals.
 * Re-run the close for stale claims; closeTradeBothLegs is idempotent
 * (cancelling already-closed orders fails harmlessly, and a reduce-only
 * close on a flat position rejects, which the flatness check converts
 * into "already flat"). */
export async function recoverStaleClosingTrades(input: {
  db: Awaited<ReturnType<typeof getDb>>;
  registry: { get(id: string): ExchangeAdapter };
  notifier: { notifyUrgent: (text: string) => Promise<void> };
  /** How long a trade may sit in 'closing' before the recovery sweep
   * re-runs its close. Defaults to 120 s (a close takes at most ~20 s). */
  closingStaleAfterMs?: number;
}): Promise<void> {
  const staleAfterMs = input.closingStaleAfterMs ?? 120_000;
  const staleClosing = await input.db
    .select()
    .from(trades)
    .where(
      and(
        eq(trades.status, "closing"),
        lt(trades.updatedAt, new Date(Date.now() - staleAfterMs)),
      ),
    );
  for (const stale of staleClosing) {
    try {
      const staleLegs = await input.db
        .select()
        .from(tradeLegs)
        .where(
          and(
            eq(tradeLegs.tradeId, stale.id),
            inArray(tradeLegs.status, ["open", "unhedged"]),
          ),
        );
      const tokenRow = (
        await input.db
          .select({ token: tradePreviews.token })
          .from(tradePreviews)
          .where(eq(tradePreviews.tradeId, stale.id))
          .orderBy(desc(tradePreviews.id))
      )[0];
      console.warn("Stale-close recovery: stale 'closing' trade found", {
        tradeId: stale.id,
        updatedAt: stale.updatedAt,
        openLegs: staleLegs.length,
      });
      // Bump updatedAt so a slow recovery is not double-fired by the next
      // tick, while a failed attempt can be retried once it goes stale again.
      await input.db
        .update(trades)
        .set({ updatedAt: new Date() })
        .where(eq(trades.id, stale.id));
      if (!tokenRow?.token) {
        console.error("Stale-close recovery aborted: no preview token", {
          tradeId: stale.id,
        });
        continue;
      }
      if (staleLegs.length === 0) {
        await new DbPreviewStore(input.db).transition(
          tokenRow.token,
          "closed",
          {
            closeReason: "close_recovery",
          },
        );
        continue;
      }
      const staleQuantity = staleLegs[0]?.quantityBase ?? null;
      if (!staleQuantity) {
        console.error("Stale-close recovery aborted: no leg quantity", {
          tradeId: stale.id,
        });
        continue;
      }
      await closeTradeBothLegs({
        store: new DbPreviewStore(input.db),
        registry: input.registry,
        token: tokenRow.token,
        label: `#${stale.id}`,
        symbol: stale.symbol,
        longExchange: stale.longExchange,
        shortExchange: stale.shortExchange,
        legs: staleLegs.map((leg) => ({
          exchangeId: leg.exchangeId,
          side: leg.side,
          quantityBase: leg.quantityBase ?? staleQuantity,
          entryPriceUsd: leg.entryPriceUsd ?? null,
          raw: leg.raw,
        })),
        reason: "close_recovery",
        notify: (text) => input.notifier.notifyUrgent(text),
      });
    } catch (error) {
      console.warn("Stale-close recovery failed", {
        tradeId: stale.id,
        message: error instanceof Error ? error.message : error,
      });
    }
  }
}
