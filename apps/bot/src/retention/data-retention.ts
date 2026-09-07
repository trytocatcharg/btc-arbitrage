import type { BotConfig } from "@btc-arbitrage/config";
import type { getDb } from "@btc-arbitrage/db";
import {
  priceSnapshots,
  signals,
  spreadSnapshots,
  trades,
  tradePreviews,
} from "@btc-arbitrage/db";
import { and, desc, isNotNull, lte, notInArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { MySqlColumn } from "drizzle-orm/mysql-core";
import { extractAffectedRows } from "../db-result.js";

const RETENTION_RUN_INTERVAL_MS = 24 * 60 * 60 * 1000;

let lastRetentionRunAtMs: number | undefined;

type Db = Awaited<ReturnType<typeof getDb>>;

/**
 * Prunes stale rows from the snapshot/signal tables using a watermark id so
 * each batched DELETE scans a bounded primary-key range. Signals are pruned
 * first (freeing spread references), then spreads, then prices.
 *
 * Rows still referenced by trades, trade previews, or signals are preserved
 * via NOT-IN subqueries so FK integrity is never violated.
 */
export async function runDataRetention(
  db: Db,
  config: BotConfig,
): Promise<void> {
  if (!config.dataRetention.enabled) return;
  if (
    lastRetentionRunAtMs !== undefined &&
    Date.now() - lastRetentionRunAtMs < RETENTION_RUN_INTERVAL_MS
  ) {
    return;
  }

  const now = Date.now();
  lastRetentionRunAtMs = now;
  const cutoff = new Date(
    now - config.dataRetention.retentionDays * 24 * 60 * 60 * 1000,
  );
  const batchSize = config.dataRetention.batchSize;

  // Signals first so spread references are freed before spread pruning.
  const signalTradeRefs = db
    .select({ signalId: trades.signalId })
    .from(trades)
    .where(isNotNull(trades.signalId));
  const signalPreviewRefs = db
    .select({ signalId: tradePreviews.signalId })
    .from(tradePreviews)
    .where(isNotNull(tradePreviews.signalId));
  await pruneTable(
    db,
    "signals",
    signals,
    signals.id,
    signals.createdAt,
    cutoff,
    batchSize,
    [
      notInArray(signals.id, signalTradeRefs),
      notInArray(signals.id, signalPreviewRefs),
    ],
  );

  const spreadSignalRefs = db
    .select({ spreadId: signals.spreadId })
    .from(signals)
    .where(isNotNull(signals.spreadId));
  await pruneTable(
    db,
    "spread_snapshots",
    spreadSnapshots,
    spreadSnapshots.id,
    spreadSnapshots.calculatedAt,
    cutoff,
    batchSize,
    [notInArray(spreadSnapshots.id, spreadSignalRefs)],
  );

  await pruneTable(
    db,
    "price_snapshots",
    priceSnapshots,
    priceSnapshots.id,
    priceSnapshots.receivedAt,
    cutoff,
    batchSize,
    [],
  );
}

async function pruneTable(
  db: Db,
  tableName: string,
  table: Parameters<Db["delete"]>[0],
  idColumn: MySqlColumn,
  timeColumn: MySqlColumn,
  cutoff: Date,
  batchSize: number,
  preservationClauses: SQL[],
): Promise<void> {
  const startedAt = Date.now();
  // Watermark: highest id older than the cutoff, so every id <= watermark is
  // eligible and each batch delete scans a bounded primary-key range.
  const watermark = (
    await db
      .select({ id: idColumn })
      .from(table)
      .where(lte(timeColumn, cutoff))
      .orderBy(desc(idColumn))
      .limit(1)
  )[0]?.id;
  if (watermark === undefined) return;

  const baseConditions = [lte(idColumn, watermark), ...preservationClauses];
  const whereClause =
    preservationClauses.length > 0
      ? and(...baseConditions)
      : lte(idColumn, watermark);

  let deletedRows = 0;
  for (;;) {
    const result = await db.delete(table).where(whereClause!).limit(batchSize);
    const affected = extractAffectedRows(result);
    deletedRows += affected;
    if (affected === 0 || affected < batchSize) break;
  }

  console.log("Data retention pruned", {
    table: tableName,
    deletedRows,
    durationMs: Date.now() - startedAt,
  });
}
