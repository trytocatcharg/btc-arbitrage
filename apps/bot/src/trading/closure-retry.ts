import { and, eq, isNull } from "drizzle-orm";
import { tradeLegs, trades, type getDb } from "@btc-arbitrage/db";
import type { ExchangeAdapter } from "@btc-arbitrage/exchange-core";
import type { BotConfig } from "@btc-arbitrage/config";
import { formatDecimal, parseDecimal } from "@btc-arbitrage/domain";
import {
  deriveLegGrossPnlUsd,
  formatClosureTotalLine,
  formatLegLine,
  readLegMarket,
  readProtectionOrderIds,
  type LegClosureSnapshot,
} from "./trade-monitor.js";

/** Leg close-reason vocabulary (trade_legs.close_reason is varchar(32);
 * the resolver returns this union; anything longer is capped to the
 * column width, never rejected). */
const LEG_CLOSE_REASON_MAX_LENGTH = 32;

/** Operator-driven re-run of the post-hoc leg-closure resolution
 * (closure-resolution-retry, trade #1370), wired to the 🔄 inline button
 * the position monitor attaches to closure notices that left exit data
 * unresolved (exit price / realized PnL NULL). The exchange may simply
 * not have indexed the closure when the monitor first looked, or the
 * protection was replaced externally and only the id-less fallbacks can
 * attribute it.
 *
 * Safety contract: the update only ever fills fields that are currently
 * NULL (with a matching WHERE guard, so a concurrent writer — e.g. a
 * racing monitor pass — is never clobbered), and the close reason is
 * only replaced while it is 'unknown'. The leg's realized PnL is stored
 * as the resolver reported it (exchange-reported, stored as-is); the
 * TRADE totals are recomputed under the always-GROSS convention
 * (operator decision 2026-10-07), same as the position monitor. */
export async function retryClosureResolution(input: {
  db: Awaited<ReturnType<typeof getDb>>;
  registry: { get(id: string): ExchangeAdapter };
  config: BotConfig;
  notify: (text: string) => Promise<void>;
  tradeId: number;
}): Promise<void> {
  const { db, registry, notify, tradeId } = input;
  // bot-instance-split: ownership filters on bot_instance — the retry
  // button was rendered by this instance's monitor, so the scoped load
  // both enforces ownership and justifies the "not found" answer.
  const trade = (
    await db
      .select()
      .from(trades)
      .where(
        and(
          eq(trades.id, tradeId),
          eq(trades.botInstance, input.config.instanceId),
        ),
      )
      .limit(1)
  )[0];
  if (!trade) {
    await notify(`⛔ Trade #${tradeId} not found.`);
    return;
  }

  const legs = await db
    .select()
    .from(tradeLegs)
    .where(eq(tradeLegs.tradeId, tradeId));
  const unresolved = legs.filter(
    (leg) =>
      leg.status === "closed" &&
      (leg.exitPriceUsd == null || leg.realizedPnlUsd == null),
  );
  if (unresolved.length === 0) {
    await notify(
      `✅ Trade #${tradeId}: nothing to retry — all closed legs already have exit data.`,
    );
    return;
  }

  const failedLegs: string[] = [];
  let updatedAny = false;

  for (const leg of unresolved) {
    const legLabel = `${leg.side.toUpperCase()} ${leg.exchangeId}`;
    try {
      const execution = registry.get(leg.exchangeId).execution;
      if (!execution?.resolveLegClosure) {
        console.warn("Closure retry: adapter cannot resolve leg closures", {
          tradeId,
          legId: leg.id,
          exchangeId: leg.exchangeId,
        });
        failedLegs.push(legLabel);
        continue;
      }
      const symbol = readLegMarket(leg.raw) ?? trade.symbol;
      const protectionIds = readProtectionOrderIds(leg.raw);
      const resolved = await execution.resolveLegClosure({
        symbol,
        side: leg.side,
        tpOrderId: protectionIds.tpOrderId,
        slOrderId: protectionIds.slOrderId,
        quantityBase: leg.quantityBase ?? undefined,
      });
      if (resolved == null) {
        console.warn("Closure retry: leg closure still unresolved", {
          tradeId,
          legId: leg.id,
          exchangeId: leg.exchangeId,
          symbol,
        });
        failedLegs.push(legLabel);
        continue;
      }

      // Fill ONLY the fields that are currently NULL, with a WHERE guard
      // matching what was read: if a concurrent writer filled the field
      // in between, the update no-ops instead of clobbering it.
      const legUpdates: Partial<typeof tradeLegs.$inferInsert> = {};
      const guards = [eq(tradeLegs.id, leg.id)];
      if (leg.exitPriceUsd == null && resolved.exitPriceUsd != null) {
        legUpdates.exitPriceUsd = resolved.exitPriceUsd;
        guards.push(isNull(tradeLegs.exitPriceUsd));
      }
      if (leg.realizedPnlUsd == null && resolved.realizedPnlUsd != null) {
        legUpdates.realizedPnlUsd = resolved.realizedPnlUsd;
        guards.push(isNull(tradeLegs.realizedPnlUsd));
      }
      if (leg.exitFeeUsd == null && resolved.feeUsd != null) {
        legUpdates.exitFeeUsd = resolved.feeUsd;
        guards.push(isNull(tradeLegs.exitFeeUsd));
      }
      if (leg.exitOrderId == null && resolved.exitOrderId != null) {
        legUpdates.exitOrderId = resolved.exitOrderId;
        guards.push(isNull(tradeLegs.exitOrderId));
      }
      if (leg.closeReason === "unknown" && resolved.closeReason != null) {
        legUpdates.closeReason = resolved.closeReason.slice(
          0,
          LEG_CLOSE_REASON_MAX_LENGTH,
        );
        guards.push(eq(tradeLegs.closeReason, "unknown"));
      }
      if (Object.keys(legUpdates).length === 0) {
        console.warn(
          "Closure retry: resolution carried no data the leg is missing",
          { tradeId, legId: leg.id, exchangeId: leg.exchangeId },
        );
        failedLegs.push(legLabel);
        continue;
      }
      await db
        .update(tradeLegs)
        .set(legUpdates)
        .where(and(...guards));
      updatedAny = true;
      console.log("Closure retry: leg updated", {
        tradeId,
        legId: leg.id,
        exchangeId: leg.exchangeId,
        fields: Object.keys(legUpdates),
      });
    } catch (error) {
      // One leg's failure must never abort the others.
      console.warn("Closure retry: leg resolution failed", {
        tradeId,
        legId: leg.id,
        exchangeId: leg.exchangeId,
        message: error instanceof Error ? error.message : String(error),
      });
      failedLegs.push(legLabel);
    }
  }

  // Refreshed legs drive both the trade-total recompute and the
  // corrected summary, so both reflect the updates above.
  const refreshedLegs = await db
    .select()
    .from(tradeLegs)
    .where(eq(tradeLegs.tradeId, tradeId));

  if (trade.status === "closed" && updatedAny) {
    // Always-GROSS convention (operator decision 2026-10-07): each leg
    // contributes its entry/exit/qty-derived gross (legs with unknown
    // exit contribute 0); the exchange-reported leg.realizedPnlUsd is
    // only deriveLegGrossPnlUsd's fallback. total_fees_usd sums the KNOWN
    // leg fees (entry + exit); NULL fees are skipped, and the column is
    // only set when at least one fee is known.
    const totalRealizedPnl = refreshedLegs.reduce((sum, leg) => {
      const gross = deriveLegGrossPnlUsd(leg);
      return sum + (gross ?? 0);
    }, 0);
    let totalFeesUsd = 0;
    let feesSeen = false;
    for (const leg of refreshedLegs) {
      for (const fee of [leg.entryFeeUsd, leg.exitFeeUsd]) {
        if (fee == null) continue;
        totalFeesUsd += parseDecimal(fee);
        feesSeen = true;
      }
    }
    await db
      .update(trades)
      .set({
        realizedPnlUsd: formatDecimal(totalRealizedPnl, 8),
        ...(feesSeen ? { totalFeesUsd: formatDecimal(totalFeesUsd, 8) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(trades.id, tradeId));
    console.log("Closure retry: trade totals recomputed", {
      tradeId,
      realizedPnlUsd: formatDecimal(totalRealizedPnl, 8),
      totalFeesUsd: feesSeen ? formatDecimal(totalFeesUsd, 8) : undefined,
    });
  }

  if (updatedAny) {
    // Corrected summary: same per-leg line formatter and total line as
    // the monitor's closure notice; only the header differs (retry
    // context).
    const snapshots: LegClosureSnapshot[] = refreshedLegs.map((leg) => ({
      side: leg.side,
      exchangeId: leg.exchangeId,
      entryPriceUsd: leg.entryPriceUsd,
      exitPriceUsd: leg.exitPriceUsd,
      realizedPnlUsd: leg.realizedPnlUsd,
      quantityBase: leg.quantityBase,
      entryFeeUsd: leg.entryFeeUsd,
      exitFeeUsd: leg.exitFeeUsd,
    }));
    const lines: string[] = [
      `✅ Trade #${tradeId}: closure resolved on retry`,
      ...snapshots.map((leg) => formatLegLine(leg)),
    ];
    if (snapshots.length >= 2) {
      lines.push("———————————————");
      lines.push(formatClosureTotalLine(snapshots[0], snapshots[1]));
    }
    await notify(lines.join("\n"));
  }

  if (failedLegs.length > 0) {
    await notify(
      `⚠️ Trade #${tradeId}: still unresolved: ${failedLegs.join(", ")}. ` +
        "Try again in a minute.",
    );
  }
}
