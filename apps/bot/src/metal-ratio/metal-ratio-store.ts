import { ratioSnapshots, type getDb } from "@btc-arbitrage/db";
import type { MetalRatioSide } from "@btc-arbitrage/domain";
import { extractInsertId } from "../db-result.js";

export interface RatioSnapshotRow {
  goldPriceUsd: string;
  silverPriceUsd: string;
  ratio: string;
  rsi?: string;
  side?: MetalRatioSide;
  crossed: boolean;
  calculatedAt: Date;
}

/** Persists one ratio tick into ratio_snapshots. Failure-isolated on
 * purpose, mirroring persistSpreadSnapshot in polling-loop.ts: returns
 * null on error so a logging failure never blocks the monitor tick. */
export async function persistRatioSnapshot(
  db: Awaited<ReturnType<typeof getDb>>,
  snapshot: RatioSnapshotRow,
): Promise<number | null> {
  try {
    const result = await db.insert(ratioSnapshots).values({
      goldPriceUsd: snapshot.goldPriceUsd,
      silverPriceUsd: snapshot.silverPriceUsd,
      ratio: snapshot.ratio,
      rsi: snapshot.rsi ?? null,
      side: snapshot.side ?? null,
      crossed: snapshot.crossed,
      calculatedAt: snapshot.calculatedAt,
    });
    const insertId = extractInsertId(result);
    return insertId !== undefined && insertId > 0 ? insertId : null;
  } catch (error) {
    console.error(
      "Failed to persist ratio snapshot",
      error instanceof Error ? { message: error.message } : { error },
    );
    return null;
  }
}
