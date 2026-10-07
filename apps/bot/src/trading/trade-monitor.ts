import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  tradeLegs,
  trades,
  type getDb,
} from "@btc-arbitrage/db";
import type { ExchangeAdapter } from "@btc-arbitrage/exchange-core";
import { formatDecimal, parseDecimal } from "@btc-arbitrage/domain";
import { shouldNotifyLegClosure } from "./trade-guards.js";
import { formatPnlColored } from "./trade-close.js";

export async function monitorTrades(input: {
  db: Awaited<ReturnType<typeof getDb>>;
  registry: { get(id: string): ExchangeAdapter };
  notify: (text: string) => Promise<void>;
}): Promise<void> {
  const rows = await input.db
    .select()
    .from(tradeLegs)
    .innerJoin(trades, eq(tradeLegs.tradeId, trades.id))
    .where(
      and(
        // F1 (trade-execution-queue Step 2, safety re-review 2026-10-07):
        // only status "open" trades are monitored. The hedge leg row
        // transitions to 'open' DURING 'hedging' while the maker limit
        // still rests, and Extended getPosition can briefly return null
        // post-fill (read lag); monitoring in-array statuses could then
        // mark that leg 'closed' + closureNotifiedAt irreversibly and
        // permanently unmonitor a leg that is actually open. Venue TP/SL
        // only exist from 'protecting'/'open', so no real closure is
        // missed by waiting for 'open'.
        eq(trades.status, "open"),
        inArray(tradeLegs.status, ["open", "unhedged"]),
        isNull(tradeLegs.closureNotifiedAt),
      ),
    );

  for (const row of rows) {
    try {
      const adapter = input.registry.get(row.trade_legs.exchangeId).execution;
      if (!adapter) continue;

      const position = await adapter.getPosition({
        symbol: row.trades.symbol,
        side: row.trade_legs.side,
      });
      const positionClosed = position === null || position.status === "closed";
      if (
        !positionClosed ||
        !shouldNotifyLegClosure({
          positionClosed,
          alreadyNotified: row.trade_legs.closureNotifiedAt != null,
        })
      )
        continue;

      // A venue-side TP/SL fire (or a manual close / moved trigger) leaves
      // the position record empty (RISEx drops it; Extended returns null),
      // so getPosition carries no exit data. Recover it post-hoc from the
      // protection order ids stored in the leg's raw JSON — or, when those
      // ids resolve nothing, from venue fill history (Arcus) —
      // (best-effort, adapter-owned, never throws).
      const protectionIds = readProtectionOrderIds(row.trade_legs.raw);
      let resolved: Awaited<
        ReturnType<NonNullable<typeof adapter.resolveLegClosure>>
      > = null;
      if (
        (position?.exitPriceUsd == null || position?.realizedPnlUsd == null) &&
        adapter.resolveLegClosure
      ) {
        try {
          resolved = await adapter.resolveLegClosure({
            symbol: row.trades.symbol,
            side: row.trade_legs.side,
            tpOrderId: protectionIds.tpOrderId,
            slOrderId: protectionIds.slOrderId,
            quantityBase: row.trade_legs.quantityBase ?? undefined,
          });
        } catch (error) {
          console.warn(
            "Leg closure resolution failed; continuing with position data",
            {
              tradeId: row.trades.id,
              legId: row.trade_legs.id,
              message: error instanceof Error ? error.message : String(error),
            },
          );
        }
      }
      // Merge recovered data behind the position data: prices only when the
      // position read left them null; the close reason only when unknown.
      const exitPriceUsd = position?.exitPriceUsd ?? resolved?.exitPriceUsd;
      const realizedPnlUsd =
        position?.realizedPnlUsd ?? resolved?.realizedPnlUsd;
      // Real exit fee: prefer the position record's fee, else the fee the
      // closure resolution recovered from the protection order payload.
      const exitFeeUsd = position?.feeUsd ?? resolved?.feeUsd;
      const positionCloseReason = position?.closeReason;
      const closeReason =
        positionCloseReason != null && positionCloseReason !== "unknown"
          ? positionCloseReason
          : (resolved?.closeReason ?? positionCloseReason ?? "unknown");

      // Farmed volume (design D6): a venue-side TP/SL closure farms volume
      // too. Increment the closing leg's and the trade's
      // filled_notional_usd by qty × exit price inside this transaction;
      // skip the increment when the exit price is unknown. Computed after
      // the closure merge so a recovered exit price is used.
      const volumeDeltaUsd =
        exitPriceUsd != null && row.trade_legs.quantityBase != null
          ? formatDecimal(
              parseDecimal(row.trade_legs.quantityBase) *
                parseDecimal(exitPriceUsd),
              8,
            )
          : null;

      const siblingSide = row.trade_legs.side === "long" ? "short" : "long";
      const siblingRows = await input.db
        .select()
        .from(tradeLegs)
        .where(
          and(
            eq(tradeLegs.tradeId, row.trade_legs.tradeId),
            eq(tradeLegs.side, siblingSide),
          ),
        );
      const sibling = siblingRows[0];

      await input.db.transaction(async (tx) => {
        const legUpdates: Partial<typeof tradeLegs.$inferInsert> = {
          status: "closed",
          closeReason,
          closedAt: new Date(),
          closureNotifiedAt: new Date(),
        };
        if (exitPriceUsd != null) legUpdates.exitPriceUsd = exitPriceUsd;
        if (realizedPnlUsd != null)
          legUpdates.realizedPnlUsd = realizedPnlUsd;
        if (exitFeeUsd != null) legUpdates.exitFeeUsd = exitFeeUsd;
        if (resolved?.exitOrderId != null)
          legUpdates.exitOrderId = resolved.exitOrderId;
        await tx
          .update(tradeLegs)
          .set(legUpdates)
          .where(
            and(
              eq(tradeLegs.id, row.trade_legs.id),
              isNull(tradeLegs.closureNotifiedAt),
            ),
          );
        if (volumeDeltaUsd !== null) {
          await tx
            .update(tradeLegs)
            .set({
              filledNotionalUsd: sql`coalesce(${tradeLegs.filledNotionalUsd}, 0) + ${volumeDeltaUsd}`,
            })
            .where(eq(tradeLegs.id, row.trade_legs.id));
        }

        const siblingAlreadyClosed = sibling?.status === "closed";
        if (siblingAlreadyClosed) {
          const allLegs = await tx
            .select()
            .from(tradeLegs)
            .where(eq(tradeLegs.tradeId, row.trades.id));
          const totalRealizedPnl = allLegs.reduce((sum, leg) => {
            if (leg.realizedPnlUsd != null)
              return sum + parseDecimal(leg.realizedPnlUsd);
            if (
              leg.exitPriceUsd != null &&
              leg.entryPriceUsd != null &&
              leg.quantityBase != null
            ) {
              const sideMul = leg.side === "long" ? 1 : -1;
              return (
                sum +
                sideMul *
                  (parseDecimal(leg.exitPriceUsd) -
                    parseDecimal(leg.entryPriceUsd)) *
                  parseDecimal(leg.quantityBase)
              );
            }
            return sum;
          }, 0);
          // trades.total_fees_usd = sum of KNOWN leg fees (entry + exit);
          // NULL leg fees are skipped, never estimated.
          let totalFeesUsd = 0;
          let feesSeen = false;
          for (const leg of allLegs) {
            for (const fee of [leg.entryFeeUsd, leg.exitFeeUsd]) {
              if (fee == null) continue;
              totalFeesUsd += parseDecimal(fee);
              feesSeen = true;
            }
          }
          await tx
            .update(trades)
            .set({
              status: "closed",
              realizedPnlUsd: formatDecimal(totalRealizedPnl, 8),
              ...(feesSeen
                ? { totalFeesUsd: formatDecimal(totalFeesUsd, 8) }
                : {}),
              closedAt: new Date(),
              updatedAt: new Date(),
              ...(volumeDeltaUsd !== null
                ? {
                    filledNotionalUsd: sql`coalesce(${trades.filledNotionalUsd}, 0) + ${volumeDeltaUsd}`,
                  }
                : {}),
            })
            .where(eq(trades.id, row.trades.id));
        } else {
          await tx
            .update(trades)
            .set({
              status: "unhedged",
              updatedAt: new Date(),
              ...(volumeDeltaUsd !== null
                ? {
                    filledNotionalUsd: sql`coalesce(${trades.filledNotionalUsd}, 0) + ${volumeDeltaUsd}`,
                  }
                : {}),
            })
            .where(eq(trades.id, row.trades.id));
        }
      });

      const siblingSnapshot: LegClosureSnapshot | null = sibling
        ? {
            side: sibling.side,
            exchangeId: sibling.exchangeId,
            entryPriceUsd: sibling.entryPriceUsd,
            exitPriceUsd: sibling.exitPriceUsd,
            realizedPnlUsd: sibling.realizedPnlUsd,
            quantityBase: sibling.quantityBase,
            entryFeeUsd: sibling.entryFeeUsd,
            exitFeeUsd: sibling.exitFeeUsd,
          }
        : null;
      const message = buildLegClosureMessage({
        tradeId: row.trades.id,
        closedLeg: {
          side: row.trade_legs.side,
          exchangeId: row.trade_legs.exchangeId,
          entryPriceUsd: row.trade_legs.entryPriceUsd,
          exitPriceUsd: exitPriceUsd ?? null,
          realizedPnlUsd: realizedPnlUsd ?? null,
          quantityBase: row.trade_legs.quantityBase,
          entryFeeUsd: row.trade_legs.entryFeeUsd,
          exitFeeUsd: exitFeeUsd ?? null,
        },
        closeReason: closeReason !== "unknown" ? closeReason : null,
        sibling: siblingSnapshot,
        siblingClosed: sibling?.status === "closed",
      });
      await input.notify(message);
    } catch (error) {
      console.warn(
        "Trade monitoring skipped adapter failure",
        error instanceof Error ? error.message : error,
      );
    }
  }
}

/** Defensive read of the protection order ids persisted in the leg's raw
 * JSON (set when the venue TP/SL backstop was placed). Any other raw shape
 * is ignored. */
function readProtectionOrderIds(raw: unknown): {
  tpOrderId?: string;
  slOrderId?: string;
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  return {
    tpOrderId:
      typeof record.tpOrderId === "string" ? record.tpOrderId : undefined,
    slOrderId:
      typeof record.slOrderId === "string" ? record.slOrderId : undefined,
  };
}

interface LegClosureSnapshot {
  side: "long" | "short";
  exchangeId: string;
  entryPriceUsd: string | null;
  exitPriceUsd: string | null;
  realizedPnlUsd: string | null;
  quantityBase: string | null;
  entryFeeUsd: string | null;
  exitFeeUsd: string | null;
}

/** Sum of the leg's KNOWN fees (entry + exit); null when none are known.
 * Fees are never estimated. */
function knownLegFeesUsd(leg: LegClosureSnapshot): number | null {
  let feesUsd = 0;
  let seen = false;
  for (const fee of [leg.entryFeeUsd, leg.exitFeeUsd]) {
    if (fee == null) continue;
    const parsed = Number(fee);
    if (!Number.isFinite(parsed)) continue;
    feesUsd += parsed;
    seen = true;
  }
  return seen ? feesUsd : null;
}

/** Exchange-agnostic GROSS leg PnL under the "always gross" convention
 * (operator decision 2026-10-07): realized columns stay fee-free and the
 * net is always realized − fees. Computed from entry/exit/qty — never
 * from the venue-reported realizedPnlUsd, whose fee convention varies by
 * exchange (Arcus nets the exit fee into it; Extended reports none at
 * all — trade #481: bot said -4.01, Extended's realized showed -4.17).
 * The venue value is only a fallback when the exit price is unknown. */
function deriveLegGrossPnlUsd(leg: LegClosureSnapshot): number | null {
  const entry = leg.entryPriceUsd != null ? Number(leg.entryPriceUsd) : null;
  const exit = leg.exitPriceUsd != null ? Number(leg.exitPriceUsd) : null;
  const qty = leg.quantityBase != null ? Number(leg.quantityBase) : null;
  if (entry != null && exit != null && qty != null)
    return (exit - entry) * qty * (leg.side === "long" ? 1 : -1);
  if (leg.realizedPnlUsd != null) {
    const parsed = Number(leg.realizedPnlUsd);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** One leg line for the closure notice: gross PnL, known fees, and net
 * (gross − fees). No entry/exit prices (operator request 2026-10-07).
 * The fees/net segments appear only when at least one fee is known. */
function formatLegLine(leg: LegClosureSnapshot): string {
  const gross = deriveLegGrossPnlUsd(leg);
  const fees = knownLegFeesUsd(leg);
  const parts = [`PnL ${formatPnlColored(gross)}`];
  if (gross != null && fees != null) {
    parts.push(`fees $${fees.toFixed(2)}`);
    parts.push(`neto ${formatPnlColored(gross - fees)}`);
  }
  return `${leg.side.toUpperCase()} ${leg.exchangeId}: ` + parts.join(" · ");
}

/** Telegram notice for a detected leg closure: per-leg entry → exit with
 * colored PnL, the exchange's close reason when known, the combined total
 * when both legs are closed, and an explicit unhedged warning otherwise. */
function buildLegClosureMessage(input: {
  tradeId: number;
  closedLeg: LegClosureSnapshot;
  closeReason: string | null;
  sibling: LegClosureSnapshot | null;
  siblingClosed: boolean;
}): string {
  const lines: string[] = [
    input.siblingClosed
      ? `✅ Trade #${input.tradeId}: ambas patas cerradas`
      : `🚨 Pata cerrada: Trade #${input.tradeId}`,
  ];
  if (input.closeReason != null && input.closeReason !== "unknown")
    lines.push(`Motivo: ${input.closeReason}`);
  lines.push(formatLegLine(input.closedLeg));
  if (input.sibling != null) {
    if (input.siblingClosed) {
      lines.push(formatLegLine(input.sibling));
      lines.push("———————————————");
      const grossA = deriveLegGrossPnlUsd(input.closedLeg);
      const grossB = deriveLegGrossPnlUsd(input.sibling);
      const totalGross =
        grossA != null && grossB != null ? grossA + grossB : null;
      const feeA = knownLegFeesUsd(input.closedLeg);
      const feeB = knownLegFeesUsd(input.sibling);
      const totalFees =
        feeA != null || feeB != null ? (feeA ?? 0) + (feeB ?? 0) : null;
      if (totalGross != null && totalFees != null) {
        lines.push(
          `PnL total: ${formatPnlColored(totalGross)} · fees $${totalFees.toFixed(2)} · neto ${formatPnlColored(totalGross - totalFees)}`,
        );
      } else {
        lines.push(`PnL total: ${formatPnlColored(totalGross)}`);
      }
    } else {
      lines.push(
        `⚠️ La pata restante sigue abierta: ` +
          `${input.sibling.side.toUpperCase()} ${input.sibling.exchangeId} (unhedged).`,
      );
    }
  }
  return lines.join("\n");
}
