import { and, desc, eq, inArray, lt } from "drizzle-orm";
import {
  trades,
  tradeLegs,
  tradePreviews,
  type getDb,
} from "@btc-arbitrage/db";
import type { ExchangeAdapter } from "@btc-arbitrage/exchange-core";
import { parseDecimal } from "@btc-arbitrage/domain";
import { closeTradeBothLegs } from "./trade-close.js";
import { DbPreviewStore } from "./db-preview-store.js";
import { extractAffectedRows } from "../db-result.js";

/** Time-stop and recovery monitor for open trades.
 *
 * Spread-USD exits were deleted by adjust-tpsl-volume-farming (PR1/1.5): the
 * spread-USD comparisons and the per-tick captured-edge gate are gone. What
 * remains: the stale-'closing' recovery sweep (close_recovery) and the
 * time-stop (spread_timeout, OPEN_TRADE_SPREAD_EXIT_TIMEOUT_MINUTES,
 * default 30 min). Live prices are still fetched per tick only to record the
 * exit spread on a time-stop close. */
export async function monitorSpreadExits(input: {
  db: Awaited<ReturnType<typeof getDb>>;
  registry: { get(id: string): ExchangeAdapter };
  notifier: { notifyUrgent: (text: string) => Promise<void> };
  /** Latest price per exchange id (from the polling loop's snapshots), used
   * only to record exitSpreadUsd on a time-stop close. */
  priceByExchange: Map<string, string>;
  timeoutMinutes: number;
  /** How long a trade may sit in 'closing' before the recovery sweep
   * re-runs its close. Defaults to 120 s (a close takes at most ~20 s). */
  closingStaleAfterMs?: number;
}): Promise<void> {
  // Recovery: a trade claimed into 'closing' whose close died mid-flight
  // (process restart, unhandled error before persist) would otherwise stay
  // 'closing' forever, suppressing signals. Re-run the close for stale
  // claims; closeTradeBothLegs is idempotent (cancelling already-closed
  // orders fails harmlessly, and a reduce-only close on a flat position
  // rejects, which the flatness check converts into "already flat").
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
      console.warn("Spread exit recovery: stale 'closing' trade found", {
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
        console.error("Spread exit recovery aborted: no preview token", {
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
        console.error("Spread exit recovery aborted: no leg quantity", {
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
      console.warn("Spread exit recovery failed", {
        tradeId: stale.id,
        message: error instanceof Error ? error.message : error,
      });
    }
  }

  const openTrades = await input.db
    .select()
    .from(trades)
    .where(eq(trades.status, "open"));
  if (openTrades.length === 0) return;

  const timeoutMs = input.timeoutMinutes * 60_000;
  const now = Date.now();

  for (const trade of openTrades) {
    try {
      const legs = await input.db
        .select()
        .from(tradeLegs)
        .where(
          and(
            eq(tradeLegs.tradeId, trade.id),
            inArray(tradeLegs.status, ["open"]),
          ),
        );
      const longLeg = legs.find((leg) => leg.side === "long");
          const shortLeg = legs.find((leg) => leg.side === "short");
          if (
            legs.length !== 2 ||
            !longLeg?.entryPriceUsd ||
            !shortLeg?.entryPriceUsd ||
            !longLeg.quantityBase
          )
            continue;

          const liveLong = input.priceByExchange.get(trade.longExchange);
          const liveShort = input.priceByExchange.get(trade.shortExchange);
          if (liveLong == null || liveShort == null) {
            console.warn("Time-stop skipped: live price unavailable", {
              tradeId: trade.id,
              longExchange: trade.longExchange,
              shortExchange: trade.shortExchange,
            });
            continue;
          }

          const liveSpread = parseDecimal(liveLong) - parseDecimal(liveShort);

          const timedOut =
            trade.openedAt && now - trade.openedAt.getTime() >= timeoutMs;
          if (!timedOut) {
            console.log("Time-stop evaluated", {
              tradeId: trade.id,
              liveSpreadUsd: liveSpread,
              openedAt: trade.openedAt,
              timeoutMinutes: input.timeoutMinutes,
            });
            continue;
          }
          const reason: "spread_timeout" = "spread_timeout";

      // Claim the trade synchronously so a concurrent close (second bot
      // process, or a re-entrant tick) cannot double-fire the exit orders.
      const claimed = await input.db
        .update(trades)
        .set({ status: "closing", updatedAt: new Date() })
        .where(and(eq(trades.id, trade.id), eq(trades.status, "open")));
      if (extractAffectedRows(claimed) === 0) continue;

      const previewRows = await input.db
        .select({ token: tradePreviews.token })
        .from(tradePreviews)
        .where(eq(tradePreviews.tradeId, trade.id))
        .orderBy(desc(tradePreviews.id));
      const token = previewRows[0]?.token;
      if (!token) {
        console.warn("Spread exit aborted: no preview token for trade", {
          tradeId: trade.id,
        });
        await input.db
          .update(trades)
          .set({ status: "open", updatedAt: new Date() })
          .where(eq(trades.id, trade.id));
        continue;
      }

      console.warn("Time-stop triggered", {
        tradeId: trade.id,
        reason,
        liveSpreadUsd: liveSpread,
      });
      const longQty = longLeg.quantityBase;
      await closeTradeBothLegs({
        store: new DbPreviewStore(input.db),
        registry: input.registry,
        token,
        label: `#${trade.id}`,
        symbol: trade.symbol,
        longExchange: trade.longExchange,
        shortExchange: trade.shortExchange,
        legs: legs.map((leg) => ({
          exchangeId: leg.exchangeId,
          side: leg.side,
          quantityBase: leg.quantityBase ?? longQty,
          entryPriceUsd: leg.entryPriceUsd ?? null,
          raw: leg.raw,
        })),
        reason,
        notify: (text) => input.notifier.notifyUrgent(text),
        exitSpreadUsd: liveSpread.toFixed(8),
      });
    } catch (error) {
      console.warn("Spread exit monitoring skipped trade failure", {
        tradeId: trade.id,
        message: error instanceof Error ? error.message : error,
      });
      // Best-effort revert: a failed close must not leave the trade stuck
      // in 'closing' (it suppresses signals forever). No-op when the
      // failure happened before the claim.
      await input.db
        .update(trades)
        .set({ status: "open", updatedAt: new Date() })
        .where(and(eq(trades.id, trade.id), eq(trades.status, "closing")));
    }
  }
}
