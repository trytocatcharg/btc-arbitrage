import { and, desc, eq, gt, inArray } from "drizzle-orm";
import {
  activeTradeStatuses,
  tradePreviews,
  tradeLegs,
  trades,
  tradeStatusHistory,
} from "@btc-arbitrage/db";
import type { getDb } from "@btc-arbitrage/db";
import { formatDecimal } from "@btc-arbitrage/domain";
import type {
  OpenTradePreview,
  OpenTradeState,
  PreviewStore,
  TransitionDetails,
} from "./open-trade.js";
import { extractAffectedRows, extractInsertId } from "../db-result.js";
import { JsonFileLogger } from "../logging/json-file-logger.js";

const dbPreviewLogger = new JsonFileLogger("logs/open-trade.jsonl");

export class DbPreviewStore implements PreviewStore {
  constructor(private readonly db: Awaited<ReturnType<typeof getDb>>) {}
  async createPreview(preview: OpenTradePreview): Promise<void> {
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
        const fallback = await tx
          .select({ id: trades.id })
          .from(trades)
          .where(
            and(
              eq(trades.signalId, row.signalId),
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
        await dbPreviewLogger.write({
          timestamp: new Date().toISOString(),
          event: "open_trade_db_trade_create_failed",
          token: preview.token,
          signalId: preview.signalId,
          symbol: preview.symbol,
          longExchange: preview.longExchange,
          shortExchange: preview.shortExchange,
          entrySpreadUsd: row.entrySpreadUsd,
        });
        throw new Error("Failed to create trade");
      }
      await dbPreviewLogger.write({
        timestamp: new Date().toISOString(),
        event: "open_trade_db_trade_created",
        token: preview.token,
        signalId: preview.signalId,
        tradeId,
      });
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
      await dbPreviewLogger.write({
        timestamp: new Date().toISOString(),
        event: "open_trade_reactivated",
        token: preview.token,
        tradeId: row.tradeId,
        quantityBase: preview.quantityBase,
      });
    });
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
    const pendingPreview = await this.db
      .select({ id: tradePreviews.id })
      .from(tradePreviews)
      .where(eq(tradePreviews.status, "awaiting_confirmation"))
      .limit(1);
    if (pendingPreview.length > 0) return true;
    const activeTrade = await this.db
      .select({ id: trades.id })
      .from(trades)
      .where(inArray(trades.status, [...activeTradeStatuses]))
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
      await dbPreviewLogger.write({
        timestamp: now.toISOString(),
        event: "open_trade_transition_without_trade",
        token,
        state,
        details,
      });
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
      if (state === "cancelled" || state === "failed") tradeSet.closedAt = now;
      await tx.update(trades).set(tradeSet).where(eq(trades.id, tradeId));
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
        if (leg.closeReason !== undefined) legSet.closeReason = leg.closeReason;
        if (leg.raw !== undefined) legSet.raw = leg.raw;
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
    });
  }
}
