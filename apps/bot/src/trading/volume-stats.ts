import { and, eq, gte, lt, sql } from "drizzle-orm";
import { type getDb, trades, tradeLegs } from "@btc-arbitrage/db";

type BotDatabase = Awaited<ReturnType<typeof getDb>>;

export interface VolumeRange {
  from: Date;
  /** Exclusive upper bound; omit for an open-ended range. */
  to?: Date;
}

export interface VolumeTotals {
  totalUsd: number;
  byExchange: Array<{ exchangeId: string; usd: number }>;
}

function toNumber(value: string | null | undefined): number {
  if (value == null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Farmed volume (the filled_notional_usd increments written by design D6):
 * the trade-level total plus the per-exchange split from trade_legs. Trades
 * are attributed to the month they were OPENED (createdAt), so a trade that
 * spans two months counts its whole cumulative volume in the first one —
 * documented approximation, there is no per-event volume ledger. */
export async function loadVolumeTotals(
  db: BotDatabase,
  range?: VolumeRange,
): Promise<VolumeTotals> {
  const rangeFilter = range
    ? range.to
      ? and(gte(trades.createdAt, range.from), lt(trades.createdAt, range.to))
      : gte(trades.createdAt, range.from)
    : undefined;
  const [totalRow] = await db
    .select({
      total: sql<string>`coalesce(sum(${trades.filledNotionalUsd}), 0)`,
    })
    .from(trades)
    .where(rangeFilter);
  const legRows = await db
    .select({
      exchangeId: tradeLegs.exchangeId,
      usd: sql<string>`coalesce(sum(${tradeLegs.filledNotionalUsd}), 0)`,
    })
    .from(tradeLegs)
    .innerJoin(trades, eq(tradeLegs.tradeId, trades.id))
    .where(rangeFilter)
    .groupBy(tradeLegs.exchangeId);
  return {
    totalUsd: toNumber(totalRow?.total),
    byExchange: legRows
      .map((row) => ({ exchangeId: row.exchangeId, usd: toNumber(row.usd) }))
      .sort((left, right) => right.usd - left.usd),
  };
}

export interface PreviousMonthRange {
  from: Date;
  to: Date;
  label: string;
}

/** Previous calendar month, UTC ("mes anterior"). */
export function previousMonthRange(now: Date = new Date()): PreviousMonthRange {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 1));
  const label = `${from.getUTCFullYear()}-${String(
    from.getUTCMonth() + 1,
  ).padStart(2, "0")}`;
  return { from, to, label };
}

/** First instant of the six-calendar-month window ending at the current
 * month, UTC (the current partial month is included). */
export function lastSixMonthsFrom(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1));
}

export interface MonthlyVolume {
  month: string;
  usd: number;
}

/** Per-calendar-month farmed volume (UTC), attributed by trade creation
 * month, for months starting at `from`. */
export async function loadMonthlyVolumeBreakdown(
  db: BotDatabase,
  from: Date,
): Promise<MonthlyVolume[]> {
  const monthExpr = sql<string>`date_format(${trades.createdAt}, '%Y-%m')`;
  const rows = await db
    .select({
      month: monthExpr,
      usd: sql<string>`coalesce(sum(${trades.filledNotionalUsd}), 0)`,
    })
    .from(trades)
    .where(gte(trades.createdAt, from))
    .groupBy(monthExpr)
    .orderBy(monthExpr);
  return rows.map((row) => ({ month: row.month, usd: toNumber(row.usd) }));
}
