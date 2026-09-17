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
import { evaluateCapturedEdge } from "./open-trade.js";
import { extractAffectedRows } from "../db-result.js";

/** Spread-based exit monitor (the primary take-profit/stop for open trades).
 *
 * For every fully-open trade it compares the live spread (long venue price −
 * short venue price, same price source as the signal engine) against the
 * spread captured at the fills:
 *
 *   move = liveSpread − capturedSpread
 *
 * and closes both legs when move ≥ tpUsd (convergence captured), move ≤ −slUsd
 * (thesis broken), or the trade has been open longer than the time-stop. The
 * ±3% venue-side TP/SL orders remain as a catastrophic backstop only; this
 * monitor is what actually expresses the strategy.
 */
export async function monitorSpreadExits(input: {
  db: Awaited<ReturnType<typeof getDb>>;
  registry: { get(id: string): ExchangeAdapter };
  notifier: { notifyUrgent: (text: string) => Promise<void> };
  /** Latest price per exchange id (from the polling loop's snapshots). */
  priceByExchange: Map<string, string>;
  spreadTpUsd: string;
  spreadSlUsd: string;
  timeoutMinutes: number;
  /** Taker fee per exchange id (bps as string), used to re-evaluate the
   * captured edge of open trades. */
  takerFeesBps: Record<string, string>;
  /** OPEN_TRADE_EDGE_MIN_PROFIT_USD. Trades whose captured edge does not
   * cover exit cost + this minimum are held on the venue TP/SL backstop
   * only: spread-based exits assume a healthy captured convergence. */
  edgeMinProfitUsd: string;
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

  const tpUsd = parseDecimal(input.spreadTpUsd);
  const slUsd = parseDecimal(input.spreadSlUsd);
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

      // Trades whose captured edge does not cover exit cost + minimum
      // profit have no convergence thesis to defend (operator decision:
      // they are held on the venue TP/SL backstop only). Spread-based
      // exits reference the captured spread and would kill such trades
      // almost immediately.
      const edge = evaluateCapturedEdge({
        longEntryUsd: longLeg.entryPriceUsd,
        shortEntryUsd: shortLeg.entryPriceUsd,
        longTakerFeeBps: input.takerFeesBps[trade.longExchange] ?? "0",
        shortTakerFeeBps: input.takerFeesBps[trade.shortExchange] ?? "0",
        minProfitUsd: input.edgeMinProfitUsd,
      });
      if (!edge.keepOpen) {
        console.log(
          "Spread exit skipped: edge below cost; venue TP/SL backstop only",
          {
            tradeId: trade.id,
            capturedSpreadUsd: edge.capturedSpreadUsd,
            remainingEdgeUsd: edge.remainingEdgeUsd,
            exitCostUsd: edge.exitCostUsd,
            minEdgeUsd: edge.minEdgeUsd,
          },
        );
        continue;
      }

      const liveLong = input.priceByExchange.get(trade.longExchange);
      const liveShort = input.priceByExchange.get(trade.shortExchange);
      if (liveLong == null || liveShort == null) {
        console.warn("Spread exit skipped: live price unavailable", {
          tradeId: trade.id,
          longExchange: trade.longExchange,
          shortExchange: trade.shortExchange,
        });
        continue;
      }

      const capturedSpread =
        parseDecimal(longLeg.entryPriceUsd) -
        parseDecimal(shortLeg.entryPriceUsd);
      const liveSpread = parseDecimal(liveLong) - parseDecimal(liveShort);
      const move = liveSpread - capturedSpread;

      let reason: "spread_tp" | "spread_sl" | "spread_timeout" | null = null;
      if (move >= tpUsd) reason = "spread_tp";
      else if (move <= -slUsd) reason = "spread_sl";
      else if (trade.openedAt && now - trade.openedAt.getTime() >= timeoutMs)
        reason = "spread_timeout";
      if (!reason) {
        console.log("Spread exit evaluated", {
          tradeId: trade.id,
          capturedSpreadUsd: capturedSpread,
          liveSpreadUsd: liveSpread,
          moveUsd: move,
          tpUsd,
          slUsd,
        });
        continue;
      }

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

      console.warn("Spread exit triggered", {
        tradeId: trade.id,
        reason,
        capturedSpreadUsd: capturedSpread,
        liveSpreadUsd: liveSpread,
        moveUsd: move,
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
