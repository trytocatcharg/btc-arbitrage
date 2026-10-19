import { and, eq, inArray, max } from "drizzle-orm";
import {
  tradeLegs,
  trades,
  unhedgedLegSamples,
  type getDb,
} from "@btc-arbitrage/db";
import type { BotConfig } from "@btc-arbitrage/config";
import type { ExchangeAdapter } from "@btc-arbitrage/exchange-core";
import { formatDecimal, parseDecimal } from "@btc-arbitrage/domain";

/**
 * Unhedged-window PnL sampling (phase 2, unhedged-pnl-sampling).
 *
 * While a trade is `unhedged` (one leg's TP/SL fired, the surviving leg is
 * naked), the monitor pass samples the survivor's mark price and GROSS
 * unrealized PnL into `unhedged_leg_samples` on UNHEDGED_SAMPLE_INTERVAL_MS
 * (0 disables). The interval is throttled from the table itself (latest
 * sampledAt per trade), so sampling survives restarts without extra state.
 *
 * PnL convention matches the always-gross rule for realized columns:
 * (mark − entry) × qty × (long ? 1 : −1), NULL when entry/qty is unknown —
 * never estimated. Sampling is best-effort: a failing adapter logs a warn
 * and the pass continues with the next leg.
 */
export async function sampleUnhedgedLegs(input: {
  db: Awaited<ReturnType<typeof getDb>>;
  registry: { get(id: string): ExchangeAdapter };
  config: BotConfig;
}): Promise<void> {
  if (input.config.unhedgedSampleIntervalMs <= 0) return;

  const rows = await input.db
    .select()
    .from(tradeLegs)
    .innerJoin(trades, eq(tradeLegs.tradeId, trades.id))
    .where(
      and(
        eq(trades.status, "unhedged"),
        // The survivor only: a 'closed' leg has no mark-to-market left.
        inArray(tradeLegs.status, ["open", "unhedged"]),
      ),
    );
  if (rows.length === 0) return;

  const tradeIds = [...new Set(rows.map((row) => row.trades.id))];
  const lastSamples = await input.db
    .select({
      tradeId: unhedgedLegSamples.tradeId,
      lastSampledAt: max(unhedgedLegSamples.sampledAt),
    })
    .from(unhedgedLegSamples)
    .where(inArray(unhedgedLegSamples.tradeId, tradeIds))
    .groupBy(unhedgedLegSamples.tradeId);
  const lastSampledAtByTrade = new Map(
    lastSamples.map((row) => [
      row.tradeId,
      row.lastSampledAt ? new Date(row.lastSampledAt).getTime() : null,
    ]),
  );

  const nowMs = Date.now();
  for (const row of rows) {
    const lastSampledAtMs = lastSampledAtByTrade.get(row.trades.id);
    if (
      lastSampledAtMs != null &&
      nowMs - lastSampledAtMs < input.config.unhedgedSampleIntervalMs
    ) {
      continue;
    }

    const leg = row.trade_legs;
    try {
      const snapshot = await input.registry
        .get(leg.exchangeId)
        .getPriceSnapshot({
          symbol: row.trades.symbol,
          marketType: input.config.marketType,
          priceSource: input.config.priceSource,
        });

      const unrealizedPnlUsd =
        leg.entryPriceUsd != null && leg.quantityBase != null
          ? formatDecimal(
              (parseDecimal(snapshot.priceUsd, "markPriceUsd") -
                parseDecimal(leg.entryPriceUsd, "entryPriceUsd")) *
                parseDecimal(leg.quantityBase, "quantityBase") *
                (leg.side === "long" ? 1 : -1),
              8,
            )
          : null;

      await input.db.insert(unhedgedLegSamples).values({
        tradeId: row.trades.id,
        legId: leg.id,
        exchangeId: leg.exchangeId,
        side: leg.side,
        markPriceUsd: snapshot.priceUsd,
        // Denormalized so rows stay immutable if the leg row later changes.
        entryPriceUsd: leg.entryPriceUsd,
        quantityBase: leg.quantityBase,
        unrealizedPnlUsd,
        sampledAt: new Date(),
      });
    } catch (error) {
      console.warn(
        "Unhedged sampling skipped leg",
        error instanceof Error
          ? {
              tradeId: row.trades.id,
              legId: leg.id,
              message: error.message,
            }
          : { tradeId: row.trades.id, legId: leg.id, error },
      );
    }
  }
}
