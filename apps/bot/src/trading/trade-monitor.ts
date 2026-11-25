import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  tradeLegs,
  trades,
  tradeStatusHistory,
  type getDb,
} from "@btc-arbitrage/db";
import type { ExchangeAdapter } from "@btc-arbitrage/exchange-core";
import type { BotConfig } from "@btc-arbitrage/config";
import { formatDecimal, parseDecimal } from "@btc-arbitrage/domain";
import { loadActiveMetalTrade } from "../metal-ratio/metal-trade-service.js";
import { resolveArcusPairConfig } from "../metal-ratio/arcus-pair-strategies.js";
import { shouldNotifyLegClosure } from "./trade-guards.js";
import { formatPnlColored } from "./trade-close.js";
import type { TelegramInlineKeyboard } from "../notifications/telegram-notifier.js";

/** Arcus position-poll throttle state (gold-silver-decouple): while a G/S
 * trade is active, the two metal legs would otherwise be polled at the
 * full 1 Hz monitor cadence — the dominant Arcus request load and the
 * 429 risk called out by the operator. Arcus legs are instead polled at
 * GOLDSILVER_PRICE_POLL_INTERVAL_MS (aligned with the metal tick). Per-leg
 * timestamp so each leg keeps its own cadence; the map only ever holds
 * arcus metal legs and one metal trade can be active at a time, so growth
 * is bounded by the number of metal trades ever opened. */
const arcusPollThrottledAtMsByLegId = new Map<number, number>();

// Bounded retry for post-hoc leg-closure resolution. A TP/SL fill can land
// in the same second the flat position is first detected while the
// order/fill reads still lag; one-shot resolution then persists
// exit_price NULL / close_reason 'unknown' (and a Telegram "n/a") forever
// — closureNotifiedAt is irreversible (trade #1101).
const CLOSURE_RESOLVE_MAX_ATTEMPTS = 3;
const CLOSURE_RESOLVE_RETRY_MS = 5_000;

export async function monitorTrades(input: {
  db: Awaited<ReturnType<typeof getDb>>;
  registry: { get(id: string): ExchangeAdapter };
  // closure-resolution-retry: the closure notice carries a "retry
  // resolution" inline button when it left unresolved exit data behind,
  // so the notifier must accept an optional keyboard (notifyUrgent does).
  notify: (text: string, keyboard?: TelegramInlineKeyboard) => Promise<void>;
  /** gold-silver-decouple: when an Arcus-pair trade is active, Arcus leg
   * position polls are throttled to the ACTIVE strategy's
   * pricePollIntervalMs (default 5 s) instead of the full monitor
   * cadence, capping Arcus request volume (429 risk). REQUIRED
   * (bot-instance-split): config.instanceId also scopes the monitored
   * legs to this bot process — there is no unscoped mode. */
  config: BotConfig;
  /** Optional trade-symbol scope: the paused main loop runs a
   * metal-only pass so a hand-closed Arcus position is still detected
   * while paused (metal trades have no resting exchange protection).
   * Absent: monitor every open/unhedged leg as before. */
  onlySymbol?: string;
}): Promise<void> {
  // One cheap probe per monitor pass; without an active Arcus-pair trade
  // the Arcus throttle does not apply at all (no Arcus-pair legs can
  // exist). The cadence comes from the ACTIVE strategy's own config
  // section (GOLDSILVER vs SPYQQQ). Instance-scoped (bot-instance-split):
  // the probe only sees trades owned by THIS bot process.
  const activeArcusPair = await loadActiveMetalTrade({
    db: input.db,
    config: input.config,
  });
  const arcusPollMinIntervalMs = activeArcusPair
    ? resolveArcusPairConfig(input.config, activeArcusPair.symbol)
        .pricePollIntervalMs
    : 0;
  const throttleArcusPolls = arcusPollMinIntervalMs > 0;

  const rows = await input.db
    .select()
    .from(tradeLegs)
    .innerJoin(trades, eq(tradeLegs.tradeId, trades.id))
    .where(
      and(
        ...(input.onlySymbol != null ? [eq(trades.symbol, input.onlySymbol)] : []),
        // bot-instance-split (CRITICAL): monitor ONLY legs owned by this
        // bot process. Two bot instances share the database with
        // different wallets; without this filter each instance's
        // getPosition would return null for the OTHER instance's legs
        // and this monitor would falsely mark them closed, fabricating
        // closures and PnL. REQUIRED: no unscoped mode exists.
        eq(trades.botInstance, input.config.instanceId),
        // F1 (trade-execution-queue Step 2, safety re-review 2026-10-07,
        // completed same day): monitor 'open' AND 'unhedged' trades. The
        // hedging-phase risk F1 guards against is real — the hedge leg row
        // transitions to 'open' DURING 'hedging' while the maker limit
        // still rests, and Extended getPosition can briefly return null
        // post-fill (read lag); monitoring 'hedging' trades could then mark
        // that leg 'closed' + closureNotifiedAt irreversibly. But 'open'
        // only is equally wrong: once one leg closes, the trade flips to
        // 'unhedged' and the remaining open leg is never polled again — its
        // exchange-side TP/SL closure goes undetected, unnotified, and the
        // trade suppresses signals forever (live bug, arcus leg, trade
        // after #481, 2026-10-07). An 'unhedged' trade is long past the
        // entry phase, so the F1 read-lag scenario cannot apply to it.
        inArray(trades.status, ["open", "unhedged"]),
        inArray(tradeLegs.status, ["open", "unhedged"]),
        isNull(tradeLegs.closureNotifiedAt),
      ),
    );

  for (const row of rows) {
    try {
      // Arcus throttle (gold-silver-decouple): skip this leg's position
      // poll until its throttled interval has elapsed. Detection latency
      // grows to ~the metal tick cadence — acceptable because the metal
      // exits (SL/TP/time-stop) are evaluated from the mark-price tick,
      // not from this poll; the poll only detects closures and notifies.
      if (throttleArcusPolls && row.trade_legs.exchangeId === "arcus") {
        const nowMs = Date.now();
        const lastPollAtMs =
          arcusPollThrottledAtMsByLegId.get(row.trade_legs.id) ?? 0;
        if (nowMs - lastPollAtMs < arcusPollMinIntervalMs) continue;
        arcusPollThrottledAtMsByLegId.set(row.trade_legs.id, nowMs);
      }

      const adapter = input.registry.get(row.trade_legs.exchangeId).execution;
      if (!adapter) continue;

      const legSymbol = readLegMarket(row.trade_legs.raw) ?? row.trades.symbol;
      const position = await adapter.getPosition({
        symbol: legSymbol,
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

      // An exchange-side TP/SL fire (or a manual close / moved trigger) leaves
      // the position record empty (RISEx drops it; Extended returns null),
      // so getPosition carries no exit data. Recover it post-hoc from the
      // protection order ids stored in the leg's raw JSON — or, when those
      // ids resolve nothing, from exchange fill history (Arcus) —
      // (best-effort, adapter-owned, never throws).
      const protectionIds = readProtectionOrderIds(row.trade_legs.raw);
      let resolved: Awaited<
        ReturnType<NonNullable<typeof adapter.resolveLegClosure>>
      > = null;
      if (
        (position?.exitPriceUsd == null || position?.realizedPnlUsd == null) &&
        adapter.resolveLegClosure
      ) {
        for (
          let attempt = 1;
          attempt <= CLOSURE_RESOLVE_MAX_ATTEMPTS;
          attempt += 1
        ) {
          try {
            resolved = await adapter.resolveLegClosure({
              symbol: legSymbol,
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
                attempt,
                message:
                  error instanceof Error ? error.message : String(error),
              },
            );
          }
          if (resolved != null) break;
          if (attempt < CLOSURE_RESOLVE_MAX_ATTEMPTS) {
            await new Promise<void>((resolve) =>
              setTimeout(resolve, CLOSURE_RESOLVE_RETRY_MS),
            );
          }
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

      // Farmed volume (design D6): an exchange-side TP/SL closure farms volume
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
          // Always-GROSS convention (operator decision 2026-10-07): each
          // leg contributes its entry/exit/qty-derived gross; the
          // exchange-reported leg.realizedPnlUsd is only a fallback when the
          // exit price is unknown (Arcus nets the exit fee into its
          // reported value — trusting it here double-counts that fee via
          // trades.total_fees_usd; trade #637: stored net -0.11 vs real
          // +0.15). Same rule as deriveLegGrossPnlUsd below.
          const totalRealizedPnl = allLegs.reduce((sum, leg) => {
            const gross = deriveLegGrossPnlUsd(leg);
            return sum + (gross ?? 0);
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
          // Status-history row (unhedged-observability): written in the same
          // transaction as the status flip so unhedged windows stay
          // reconstructible from trade_status_history alone.
          await tx.insert(tradeStatusHistory).values({
            tradeId: row.trades.id,
            fromStatus: row.trades.status,
            toStatus: "closed",
            reason: closeReason.slice(0, 512),
            metadata: { source: "position-monitor", closeReason },
            changedAt: new Date(),
          });
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
          // Status-history row (unhedged-observability): the unhedged flip
          // starts a window the backend derives from trade_status_history;
          // the insert stays inside this transaction so the window start is
          // atomic with the status update.
          await tx.insert(tradeStatusHistory).values({
            tradeId: row.trades.id,
            fromStatus: row.trades.status,
            toStatus: "unhedged",
            reason: closeReason.slice(0, 512),
            metadata: {
              source: "position-monitor",
              closedLegId: row.trade_legs.id,
              closedLegSide: row.trade_legs.side,
              closedLegExchangeId: row.trade_legs.exchangeId,
              closeReason,
            },
            changedAt: new Date(),
          });
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
      // closure-resolution-retry (trade #1370): when the closure left
      // unresolved exit data behind — on the closed leg itself (merged
      // position+resolver values) or on an already-closed sibling — the
      // notice carries a retry button so the operator can re-run the
      // post-hoc resolution once the exchange has indexed the closure.
      const closedLegUnresolved = exitPriceUsd == null || realizedPnlUsd == null;
      const siblingUnresolved =
        siblingSnapshot != null &&
        sibling?.status === "closed" &&
        (siblingSnapshot.exitPriceUsd == null ||
          siblingSnapshot.realizedPnlUsd == null);
      const retryKeyboard: TelegramInlineKeyboard | undefined =
        closedLegUnresolved || siblingUnresolved
          ? {
              inline_keyboard: [
                [
                  {
                    text: "🔄 Reintentar resolución",
                    callback_data: `closureretry:${row.trades.id}`,
                  },
                ],
              ],
            }
          : undefined;
      await input.notify(message, retryKeyboard);
    } catch (error) {
      console.warn(
        "Trade monitoring skipped adapter failure",
        error instanceof Error ? error.message : error,
      );
    }
  }
}

/** Defensive read of the per-leg market symbol persisted in the leg's raw
 * JSON (metal-ratio trades: the trade symbol is the GOLDSILVER
 * pseudo-pair, not resolvable by any exchange). Falls back to undefined so
 * callers keep the trade-level symbol. Exported for closure-retry. */
export function readLegMarket(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const market = (raw as Record<string, unknown>).market;
  return typeof market === "string" && market.length > 0 ? market : undefined;
}

/** Defensive read of the protection order ids persisted in the leg's raw
 * JSON (set when the exchange TP/SL backstop was placed). Any other raw shape
 * is ignored. Exported for closure-retry. */
export function readProtectionOrderIds(raw: unknown): {
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

export interface LegClosureSnapshot {
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
 * from the exchange-reported realizedPnlUsd, whose fee convention varies by
 * exchange (Arcus nets the exit fee into it; Extended reports none at
 * all — trade #481: bot said -4.01, Extended's realized showed -4.17).
 * The exchange value is only a fallback when the exit price is unknown.
 * Exported for closure-retry. */
export function deriveLegGrossPnlUsd(leg: LegClosureSnapshot): number | null {
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
 * The fees/net segments appear only when at least one fee is known.
 * Exported for closure-retry. */
export function formatLegLine(leg: LegClosureSnapshot): string {
  const gross = deriveLegGrossPnlUsd(leg);
  const fees = knownLegFeesUsd(leg);
  const parts = [`PnL ${formatPnlColored(gross)}`];
  if (gross != null && fees != null) {
    parts.push(`fees $${fees.toFixed(2)}`);
    parts.push(`net ${formatPnlColored(gross - fees)}`);
  }
  return `${leg.side.toUpperCase()} ${leg.exchangeId}: ` + parts.join(" · ");
}

/** Combined total line for a two-leg closure notice: gross sum, known
 * fees, and net. Exported for closure-retry so the retried summary keeps
 * the exact same formatting as the monitor's closure notice. */
export function formatClosureTotalLine(
  legA: LegClosureSnapshot,
  legB: LegClosureSnapshot,
): string {
  const grossA = deriveLegGrossPnlUsd(legA);
  const grossB = deriveLegGrossPnlUsd(legB);
  const totalGross = grossA != null && grossB != null ? grossA + grossB : null;
  const feeA = knownLegFeesUsd(legA);
  const feeB = knownLegFeesUsd(legB);
  const totalFees =
    feeA != null || feeB != null ? (feeA ?? 0) + (feeB ?? 0) : null;
  if (totalGross != null && totalFees != null) {
    return `Total PnL: ${formatPnlColored(totalGross)} · fees $${totalFees.toFixed(2)} · net ${formatPnlColored(totalGross - totalFees)}`;
  }
  return `PnL total: ${formatPnlColored(totalGross)}`;
}

/** Telegram notice for a detected leg closure: per-leg entry → exit with
 * colored PnL, the exchange's close reason when known, the combined total
 * when both legs are closed, and an explicit unhedged warning otherwise.
 * Exported for closure-retry. */
export function buildLegClosureMessage(input: {
  tradeId: number;
  closedLeg: LegClosureSnapshot;
  closeReason: string | null;
  sibling: LegClosureSnapshot | null;
  siblingClosed: boolean;
}): string {
  const lines: string[] = [
    input.siblingClosed
      ? `✅ Trade #${input.tradeId}: both legs closed`
      : `🚨 Leg closed: Trade #${input.tradeId}`,
  ];
  if (input.closeReason != null && input.closeReason !== "unknown")
    lines.push(`Reason: ${input.closeReason}`);
  lines.push(formatLegLine(input.closedLeg));
  if (input.sibling != null) {
    if (input.siblingClosed) {
      lines.push(formatLegLine(input.sibling));
      lines.push("———————————————");
      lines.push(formatClosureTotalLine(input.closedLeg, input.sibling));
    } else {
      lines.push(
        `⚠️ The remaining leg is still open: ` +
          `${input.sibling.side.toUpperCase()} ${input.sibling.exchangeId} (unhedged).`,
      );
    }
  }
  return lines.join("\n");
}
