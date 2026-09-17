import { getDb, trades, tradeLegs } from '@btc-arbitrage/db';
import { and, eq, gte, sql } from 'drizzle-orm';

type Db = Awaited<ReturnType<typeof getDb>>;

export interface VenueVolumeSnapshot {
  exchangeId: string;
  /** Raw decimal string straight from the MySQL `sum()` aggregate. */
  volumeUsd: string;
}

export interface VolumeTotalsSnapshot {
  /** Raw decimal string straight from the MySQL `sum()` aggregate. */
  totalUsd: string;
  byVenue: VenueVolumeSnapshot[];
}

export interface RawVolumeStats {
  generatedAt: Date;
  lifetime: VolumeTotalsSnapshot;
  windows: {
    '24h': VolumeTotalsSnapshot;
    '7d': VolumeTotalsSnapshot;
    '30d': VolumeTotalsSnapshot;
  };
}

export interface VolumeStatsService {
  getVolumeStats(): Promise<RawVolumeStats>;
}

const WINDOW_DEFINITIONS = [
  { key: '24h', cutoffMs: 24 * 60 * 60 * 1000 },
  { key: '7d', cutoffMs: 7 * 24 * 60 * 60 * 1000 },
  { key: '30d', cutoffMs: 30 * 24 * 60 * 60 * 1000 }
] as const;

/**
 * Read-only farmed-volume aggregation over the bot's database (volume-farming spec).
 *
 * Trailing windows (24h / 7d / 30d) are pinned to `trades.updatedAt` — the last
 * fill/close activity on the trade — because `trade_legs` has no `updated_at`
 * column and every volume writer touches the trade row in the same transaction
 * (design Open Question 4).
 *
 * Caveat: a trade opened before the window but closed (or otherwise written)
 * within it contributes its *cumulative* `filled_notional_usd` to the window —
 * not just the in-window delta. That is intentional: the volume counts as
 * farmed at write time, matching the Telegram `/summary` 24h convention.
 */
export function createVolumeStatsService(): VolumeStatsService {
  return {
    async getVolumeStats(): Promise<RawVolumeStats> {
      const db = await getDb();
      const generatedAt = new Date();

      const lifetime = await readTotals(db);
      const windows = {} as RawVolumeStats['windows'];
      for (const window of WINDOW_DEFINITIONS) {
        const cutoff = new Date(generatedAt.getTime() - window.cutoffMs);
        windows[window.key] = await readTotals(db, cutoff);
      }

      return { generatedAt, lifetime, windows };
    }
  };
}

async function readTotals(db: Db, cutoff?: Date): Promise<VolumeTotalsSnapshot> {
  const conditions = cutoff ? [gte(trades.updatedAt, cutoff)] : [];

  const totalRows = await db
    .select({ totalUsd: sql<string>`coalesce(sum(${trades.filledNotionalUsd}), 0)` })
    .from(trades)
    .where(and(...conditions));

  const byVenueRows = await db
    .select({
      exchangeId: tradeLegs.exchangeId,
      volumeUsd: sql<string>`coalesce(sum(${tradeLegs.filledNotionalUsd}), 0)`
    })
    .from(tradeLegs)
    .innerJoin(trades, eq(tradeLegs.tradeId, trades.id))
    .where(and(...conditions))
    .groupBy(tradeLegs.exchangeId);

  return {
    totalUsd: totalRows[0]?.totalUsd ?? '0',
    byVenue: byVenueRows
  };
}
