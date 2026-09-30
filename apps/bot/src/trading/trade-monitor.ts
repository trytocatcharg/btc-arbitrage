import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  activeTradeStatuses,
  tradeLegs,
  trades,
  type getDb,
} from "@btc-arbitrage/db";
import type { ExchangeAdapter } from "@btc-arbitrage/exchange-core";
import { formatDecimal, parseDecimal } from "@btc-arbitrage/domain";
import { shouldNotifyLegClosure } from "./trade-guards.js";
import { formatPnlColored, formatUsdOrNa } from "./trade-close.js";

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
        inArray(trades.status, [...activeTradeStatuses]),
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

      // A venue-side TP/SL fire leaves the position record empty (RISEx
      // drops it; Extended returns null), so getPosition carries no exit
      // data. Recover it post-hoc from the protection order ids stored in
      // the leg's raw JSON (best-effort, adapter-owned, never throws).
      const protectionIds = readProtectionOrderIds(row.trade_legs.raw);
      let resolved: Awaited<
        ReturnType<NonNullable<typeof adapter.resolveLegClosure>>
      > = null;
      if (
        (position?.exitPriceUsd == null || position?.realizedPnlUsd == null) &&
        (protectionIds.tpOrderId != null || protectionIds.slOrderId != null) &&
        adapter.resolveLegClosure
      ) {
        try {
          resolved = await adapter.resolveLegClosure({
            symbol: row.trades.symbol,
            side: row.trade_legs.side,
            tpOrderId: protectionIds.tpOrderId,
            slOrderId: protectionIds.slOrderId,
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
}

/** Exchange-agnostic leg PnL: the exchange-reported realized value when
 * present, else derived from entry/exit/qty (same convention as
 * trade-close). */
function deriveLegPnlUsd(leg: LegClosureSnapshot): number | null {
  if (leg.realizedPnlUsd != null) {
    const parsed = Number(leg.realizedPnlUsd);
    if (Number.isFinite(parsed)) return parsed;
  }
  const entry = leg.entryPriceUsd != null ? Number(leg.entryPriceUsd) : null;
  const exit = leg.exitPriceUsd != null ? Number(leg.exitPriceUsd) : null;
  const qty = leg.quantityBase != null ? Number(leg.quantityBase) : null;
  if (entry == null || exit == null || qty == null) return null;
  const sideMul = leg.side === "long" ? 1 : -1;
  return (exit - entry) * qty * sideMul;
}

function formatLegLine(leg: LegClosureSnapshot, pnl: number | null): string {
  return (
    `${leg.side.toUpperCase()} ${leg.exchangeId}: ` +
    `${formatUsdOrNa(leg.entryPriceUsd)} → ${formatUsdOrNa(leg.exitPriceUsd)} ` +
    `· PnL ${formatPnlColored(pnl)}`
  );
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
  const closedPnl = deriveLegPnlUsd(input.closedLeg);
  const siblingPnl =
    input.sibling != null ? deriveLegPnlUsd(input.sibling) : null;
  const lines: string[] = [
    input.siblingClosed
      ? `✅ Trade #${input.tradeId}: ambas patas cerradas`
      : `🚨 Pata cerrada: Trade #${input.tradeId}`,
  ];
  if (input.closeReason != null && input.closeReason !== "unknown")
    lines.push(`Motivo: ${input.closeReason}`);
  lines.push(formatLegLine(input.closedLeg, closedPnl));
  if (input.sibling != null) {
    if (input.siblingClosed) {
      lines.push(formatLegLine(input.sibling, siblingPnl));
      lines.push("———————————————");
      const total =
        closedPnl != null && siblingPnl != null ? closedPnl + siblingPnl : null;
      lines.push(`PnL total: ${formatPnlColored(total)}`);
    } else {
      lines.push(
        `⚠️ La pata restante sigue abierta: ` +
          `${input.sibling.side.toUpperCase()} ${input.sibling.exchangeId} (unhedged).`,
      );
    }
  }
  return lines.join("\n");
}
