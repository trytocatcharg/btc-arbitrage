import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  notInArray,
  sql,
} from "drizzle-orm";
import {
  activeTradeStatuses,
  tradePreviews,
  tradeLegs,
  trades,
  tradeStatusHistory,
} from "@btc-arbitrage/db";
import type { getDb } from "@btc-arbitrage/db";
import {
  ARCUS_PAIR_SYMBOLS,
  formatDecimal,
  parseDecimal,
} from "@btc-arbitrage/domain";
import type {
  OpenTradePreview,
  OpenTradeState,
  PreviewStore,
  TransitionDetails,
} from "./open-trade.js";
import { extractAffectedRows, extractInsertId } from "../db-result.js";

export class DbPreviewStore implements PreviewStore {
  /**
   * @param instanceId bot-instance-split: the owning bot process id
   * (config.instanceId). Required for the ownership-scoped operations
   * (createPreview / startExecution / hasBlockingExecution) — they stamp
   * and filter rows by trades/trade_previews.bot_instance. Transition-only
   * stores (close/recovery flows operate by token) may omit it.
   */
  constructor(
    private readonly db: Awaited<ReturnType<typeof getDb>>,
    private readonly instanceId?: string,
  ) {}

  /** Fail-closed accessor: ownership-scoped operations never run without
   * the instance id (a missing id must die loudly, never stamp or scan
   * rows across instances). */
  private requireInstanceId(): string {
    if (!this.instanceId) {
      throw new Error(
        "DbPreviewStore: bot instance id is required for ownership-scoped operations",
      );
    }
    return this.instanceId;
  }

  async createPreview(preview: OpenTradePreview): Promise<void> {
    const instanceId = this.requireInstanceId();
    if (await this.hasBlockingExecution())
      throw new Error(
        "Cannot open a new trade: another trade is active or awaiting confirmation",
      );
    await this.db.insert(tradePreviews).values({
      signalId: preview.signalId,
      token: preview.token,
      status: "awaiting_confirmation",
      expiresAt: preview.expiresAt,
      payload: preview,
      // bot-instance-split: the preview row is stamped with the owning
      // bot process (both the signal-driven and /arb screener paths
      // funnel through this method).
      botInstance: instanceId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  async consumePreview(
    token: string,
    now: Date,
  ): Promise<OpenTradePreview | null> {
    const rows = await this.db
      .select()
      .from(tradePreviews)
      .where(
        and(
          eq(tradePreviews.token, token),
          eq(tradePreviews.status, "awaiting_confirmation"),
          gt(tradePreviews.expiresAt, now),
        ),
      );
    const row = rows[0];
    if (!row) return null;
    const changed = await this.db
      .update(tradePreviews)
      .set({ status: "executing_limit", consumedAt: now, updatedAt: now })
      .where(
        and(
          eq(tradePreviews.id, row.id),
          eq(tradePreviews.status, "awaiting_confirmation"),
        ),
      );
    if (extractAffectedRows(changed) !== 1) return null;
    // SAFETY: the payload JSON column was written by createPreview() from a
    // verified OpenTradePreview object; its shape is invariant across versions.
    return row.payload as unknown as OpenTradePreview;
  }
  async startExecution(
    preview: OpenTradePreview,
    leverage: number,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const createdAt = new Date();
      const row = {
        signalId: preview.signalId,
        symbol: preview.symbol,
        marketType: preview.marketType,
        priceSource: "last" as const,
        mode: "live" as const,
        status: "executing_limit" as const,
        longExchange: preview.longExchange,
        shortExchange: preview.shortExchange,
        leverage,
        // bot-instance-split: the trade row is stamped with the owning
        // bot process; every monitor/ownership query filters on it.
        botInstance: this.requireInstanceId(),
        entrySpreadUsd: formatDecimal(
          Number(preview.shortPriceUsd) - Number(preview.longPriceUsd),
          8,
        ),
        createdAt,
        updatedAt: createdAt,
      };
      const inserted = await tx.insert(trades).values(row);
      let tradeId = extractInsertId(inserted) ?? 0;
      if (!tradeId) {
        // Fallback re-lookup. With signalId NULL (/arb screener previews)
        // eq(signalId, null) could never match, so the predicate switches
        // to IS NULL; a miss still fails loudly below.
        const signalPredicate =
          row.signalId == null
            ? isNull(trades.signalId)
            : eq(trades.signalId, row.signalId);
        const fallback = await tx
          .select({ id: trades.id })
          .from(trades)
          .where(
            and(
              signalPredicate,
              eq(trades.symbol, row.symbol),
              eq(trades.marketType, row.marketType),
              eq(trades.priceSource, row.priceSource),
              eq(trades.mode, row.mode),
              eq(trades.status, row.status),
              eq(trades.longExchange, row.longExchange),
              eq(trades.shortExchange, row.shortExchange),
              eq(trades.leverage, row.leverage),
              eq(trades.entrySpreadUsd, row.entrySpreadUsd),
            ),
          )
          .orderBy(desc(trades.id));
        tradeId = Number(fallback[0]?.id ?? 0);
      }
      if (!tradeId) {
        throw new Error("Failed to create trade");
      }
      await tx.insert(tradeLegs).values([
        {
          tradeId,
          exchangeId: preview.longExchange,
          side: "long",
          status: "planned",
          quantityBase: preview.quantityBase,
        },
        {
          tradeId,
          exchangeId: preview.shortExchange,
          side: "short",
          status: "planned",
          quantityBase: preview.quantityBase,
        },
      ]);
      await tx
        .update(tradePreviews)
        .set({ tradeId, updatedAt: new Date() })
        .where(eq(tradePreviews.token, preview.token));
    });
  }
  async reactivateExecution(preview: OpenTradePreview): Promise<void> {
    await this.db.transaction(async (tx) => {
      const row = (
        await tx
          .select({ id: tradePreviews.id, tradeId: tradePreviews.tradeId })
          .from(tradePreviews)
          .where(eq(tradePreviews.token, preview.token))
      )[0];
      if (!row?.tradeId)
        throw new Error(
          `Cannot reactivate execution: preview ${preview.token} has no linked trade`,
        );
      const updated = await tx
        .update(tradePreviews)
        .set({
          status: "executing_limit",
          payload: preview,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(tradePreviews.id, row.id),
            eq(tradePreviews.status, "cancelled"),
          ),
        );
      if (extractAffectedRows(updated) !== 1)
        throw new Error(
          `Cannot reactivate preview ${preview.token}: expected exactly 1 affected row`,
        );
      await tx
        .update(trades)
        .set({ status: "executing_limit", updatedAt: new Date() })
        .where(eq(trades.id, row.tradeId));
      await tx
        .update(tradeLegs)
        .set({ quantityBase: preview.quantityBase })
        .where(eq(tradeLegs.tradeId, row.tradeId));
    });
  }
  /** Cumulative farmed volume (trades.filled_notional_usd) for the trade
   * linked to a preview token; null when unknown. Used by close notices. */
  async readFarmedVolumeUsd(token: string): Promise<string | null> {
    const rows = await this.db
      .select({ filledNotionalUsd: trades.filledNotionalUsd })
      .from(trades)
      .innerJoin(tradePreviews, eq(tradePreviews.tradeId, trades.id))
      .where(eq(tradePreviews.token, token));
    return rows[0]?.filledNotionalUsd ?? null;
  }
  async claimRollback(token: string): Promise<boolean> {
    const result = await this.db
      .update(tradePreviews)
      .set({ status: "rolling_back", updatedAt: new Date() })
      .where(
        and(
          eq(tradePreviews.token, token),
          inArray(tradePreviews.status, [
            "executing_limit",
            "hedging",
            "protecting",
          ]),
        ),
      );
    return extractAffectedRows(result) === 1;
  }
  async hasBlockingExecution(): Promise<boolean> {
    const instanceId = this.requireInstanceId();
    const pendingPreview = await this.db
      .select({ id: tradePreviews.id })
      .from(tradePreviews)
      .where(
        and(
          eq(tradePreviews.status, "awaiting_confirmation"),
          eq(tradePreviews.botInstance, instanceId),
        ),
      )
      .limit(1);
    if (pendingPreview.length > 0) return true;
    // gold-silver-decouple: active GOLD/SILVER trades do NOT block BTC
    // entries — the strategies run on disjoint venues (BTC on the spread
    // exchanges, metal on Arcus), so there is no collateral or execution
    // conflict. A second BTC trade while another BTC trade is active is
    // still blocked by this same query.
    // bot-instance-split: ownership is decided by the bot_instance column
    // (WHO owns the row); the Arcus-pair symbol exclusion stays as a
    // strategy-KIND discriminator (BTC entries never conflict with
    // Arcus-pair trades of the SAME instance), which only matters for a
    // both-strategy instance. This is not a symbol ownership fallback.
    const activeTrade = await this.db
      .select({ id: trades.id })
      .from(trades)
      .where(
        and(
          inArray(trades.status, [...activeTradeStatuses]),
          eq(trades.botInstance, instanceId),
          notInArray(trades.symbol, [...ARCUS_PAIR_SYMBOLS]),
        ),
      )
      .limit(1);
    return activeTrade.length > 0;
  }
  async transition(
    token: string,
    state: OpenTradeState,
    details?: TransitionDetails,
  ): Promise<void> {
    const now = new Date();
    await this.db
      .update(tradePreviews)
      .set({ status: state, updatedAt: now })
      .where(eq(tradePreviews.token, token));
    const previewRows = await this.db
      .select({ tradeId: tradePreviews.tradeId })
      .from(tradePreviews)
      .where(eq(tradePreviews.token, token));
    const tradeId = previewRows[0]?.tradeId;
    if (!tradeId) {
      return;
    }
    await this.db.transaction(async (tx) => {
      const tradeRows = await tx
        .select({ status: trades.status, openedAt: trades.openedAt })
        .from(trades)
        .where(eq(trades.id, tradeId));
      const fromStatus = tradeRows[0]?.status;
      const tradeSet: Partial<typeof trades.$inferInsert> = {
        status: state,
        updatedAt: now,
      };
      if (state === "open" && !tradeRows[0]?.openedAt) tradeSet.openedAt = now;
      if (state === "cancelled" || state === "failed" || state === "closed")
        tradeSet.closedAt = now;
      if (typeof details?.realizedPnlUsd === "string")
        tradeSet.realizedPnlUsd = details.realizedPnlUsd;
      if (typeof details?.exitSpreadUsd === "string")
        tradeSet.exitSpreadUsd = details.exitSpreadUsd;
      await tx.update(trades).set(tradeSet).where(eq(trades.id, tradeId));
      if (typeof details?.filledNotionalUsdDelta === "string") {
        // Trade-level farmed-volume increment (monotonic coalesce+delta)
        // inside the same transaction.
        await tx
          .update(trades)
          .set({
            filledNotionalUsd: sql`coalesce(${trades.filledNotionalUsd}, 0) + ${details.filledNotionalUsdDelta}`,
          })
          .where(eq(trades.id, tradeId));
      }
      await tx.insert(tradeStatusHistory).values({
        tradeId,
        fromStatus,
        toStatus: state,
        reason: (details?.error ?? details?.closeReason)?.slice(0, 512) ?? null,
        metadata: details,
        changedAt: now,
      });
      for (const leg of details?.legs ?? []) {
        const legSet: Partial<typeof tradeLegs.$inferInsert> = {};
        if (leg.status !== undefined) {
          legSet.status = leg.status;
          if (leg.status === "open") legSet.openedAt = now;
          if (
            leg.status === "closed" ||
            leg.status === "cancelled" ||
            leg.status === "failed"
          )
            legSet.closedAt = now;
        }
        if (leg.entryOrderId !== undefined)
          legSet.entryOrderId = leg.entryOrderId;
        if (leg.exitOrderId !== undefined) legSet.exitOrderId = leg.exitOrderId;
        if (leg.entryPriceUsd !== undefined)
          legSet.entryPriceUsd = leg.entryPriceUsd;
        if (leg.exitPriceUsd !== undefined)
          legSet.exitPriceUsd = leg.exitPriceUsd;
        if (leg.realizedPnlUsd !== undefined)
          legSet.realizedPnlUsd = leg.realizedPnlUsd;
        if (leg.quantityBase !== undefined)
          legSet.quantityBase = leg.quantityBase;
        if (leg.entryFeeUsd !== undefined)
          legSet.entryFeeUsd = leg.entryFeeUsd;
        if (leg.exitFeeUsd !== undefined) legSet.exitFeeUsd = leg.exitFeeUsd;
        if (leg.closeReason !== undefined) legSet.closeReason = leg.closeReason;
        if (leg.raw !== undefined) legSet.raw = leg.raw;
        // Legs that only carry filledNotionalUsdDelta leave legSet empty;
        // Drizzle throws "No values to set" on an empty .set(), which
        // crashed the whole confirm flow into rollback (observed
        // 2026-09-21). Skip the row update — the delta below is the only
        // mutation for such legs.
        if (Object.keys(legSet).length > 0) {
          await tx
            .update(tradeLegs)
            .set(legSet)
            .where(
              and(
                eq(tradeLegs.tradeId, tradeId),
                eq(tradeLegs.exchangeId, leg.exchangeId),
                eq(tradeLegs.side, leg.side),
              ),
            );
        }
        if (leg.filledNotionalUsdDelta !== undefined) {
          // Monotonic farmed-volume increment (coalesce + delta) inside the same
          // transaction; safe under the stale-'closing' recovery re-close because
          // the delta rides a transition that is only persisted once.
          await tx
            .update(tradeLegs)
            .set({
              filledNotionalUsd: sql`coalesce(${tradeLegs.filledNotionalUsd}, 0) + ${leg.filledNotionalUsdDelta}`,
            })
            .where(
              and(
                eq(tradeLegs.tradeId, tradeId),
                eq(tradeLegs.exchangeId, leg.exchangeId),
                eq(tradeLegs.side, leg.side),
              ),
            );
        }
      }
      if (state === "closed" || state === "failed") {
        // trades.total_fees_usd = sum of KNOWN leg fees (entry + exit),
        // computed inside the closing transaction so every store-mediated
        // close path (spread close, edge abort, rollback) lands it the same
        // way. NULL leg fees are skipped, never estimated.
        const feeRows = await tx
          .select({
            entryFeeUsd: tradeLegs.entryFeeUsd,
            exitFeeUsd: tradeLegs.exitFeeUsd,
          })
          .from(tradeLegs)
          .where(eq(tradeLegs.tradeId, tradeId));
        let totalFeesUsd = 0;
        let feesSeen = false;
        for (const row of feeRows) {
          for (const fee of [row.entryFeeUsd, row.exitFeeUsd]) {
            if (fee == null) continue;
            totalFeesUsd += parseDecimal(fee);
            feesSeen = true;
          }
        }
        if (feesSeen) {
          await tx
            .update(trades)
            .set({ totalFeesUsd: formatDecimal(totalFeesUsd, 8) })
            .where(eq(trades.id, tradeId));
        }
      }
    });
  }
}
