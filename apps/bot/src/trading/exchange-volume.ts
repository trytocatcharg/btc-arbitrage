import { and, eq, gte, sql } from "drizzle-orm";
import { type getDb, trades, tradeLegs } from "@btc-arbitrage/db";
import { DEFAULT_TRADING_PAIR_SYMBOL } from "@btc-arbitrage/domain";
import type {
  AccountFill,
  ExchangeAdapter,
} from "@btc-arbitrage/exchange-core";
import { loadVolumeTotals } from "./volume-stats.js";

type BotDatabase = Awaited<ReturnType<typeof getDb>>;

export interface ExchangeVolumeTotals {
  totalUsd: number;
  byExchange: Array<{ exchangeId: string; usd: number }>;
  /** Per-UTC-month exchange volume (YYYY-MM), attributed by fill month. */
  byMonth: Map<string, number>;
  /** Exchange ids whose numbers came from the DB fallback (rendered "· db"). */
  exchangesFromDb: string[];
}

export interface ExchangeVolumeRange {
  /** Inclusive lower bound on fill time. */
  from?: Date;
  /** Exclusive upper bound on fill time. */
  to?: Date;
}

/** Structural match for the poller's ExchangeRegistryLike: the runtime
 * registry (createExchangeRegistry) only exposes get(id). */
export interface ExchangeVolumeRegistry {
  get(id: string): ExchangeAdapter;
}

/** Registry membership mirrored from createExchangeRegistry (registry.ts):
 * the registry interface only exposes get(id), so /volume enumerates the
 * exchange ids the registry hardcodes; an id that stops being registered is
 * skipped via the get() throw. */
const EXCHANGE_IDS = ["risex", "extended", "arcus"] as const;

/** In-memory TTL for the exchange aggregates: /volume is operator-driven and
 * the underlying exchange histories change only when a trade fills, so a
 * 60-second window keeps repeated view switches cheap without serving
 * stale numbers for long. */
const EXCHANGE_VOLUME_CACHE_TTL_MS = 60_000;

const exchangeVolumeCache = new Map<
  string,
  { value: ExchangeVolumeTotals; expiresAt: number }
>();

/**
 * Exchange-direct volume for the Telegram /volume command: every registered
 * exchange with a getAccountFills implementation contributes its
 * exchange-reported account fills (notional summed per exchange and per UTC
 * fill month, optionally range-filtered). An exchange whose method is missing
 * or throws degrades to that exchange's DB numbers (volume-stats), and its
 * id lands in exchangesFromDb so the renderer can mark it "· db". Never
 * throws: an exchange that fails BOTH paths contributes nothing and is logged.
 */
export async function loadExchangeVolume(
  db: BotDatabase,
  registry: ExchangeVolumeRegistry,
  range: ExchangeVolumeRange = {},
): Promise<ExchangeVolumeTotals> {
  const cacheKey = `${range.from?.toISOString() ?? "all"}|${range.to?.toISOString() ?? "open"}`;
  const cached = exchangeVolumeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const exchanges: Array<{ id: string; adapter: ExchangeAdapter }> = [];
  for (const id of EXCHANGE_IDS) {
    try {
      exchanges.push({ id, adapter: registry.get(id) });
    } catch {
      // Not registered in this runtime — skip it.
    }
  }

  const settled = await Promise.all(
    exchanges.map(async (exchange) => {
      const execution = exchange.adapter.execution;
      if (!execution?.getAccountFills) return { id: exchange.id, fills: null };
      try {
        const fills = await execution.getAccountFills({
          symbol: DEFAULT_TRADING_PAIR_SYMBOL,
        });
        return { id: exchange.id, fills } as {
          id: string;
          fills: AccountFill[] | null;
        };
      } catch (error) {
        console.warn(
          "Exchange volume fetch failed; falling back to DB numbers for this exchange",
          {
            exchangeId: exchange.id,
            message: error instanceof Error ? error.message : String(error),
          },
        );
        return { id: exchange.id, fills: null } as {
          id: string;
          fills: AccountFill[] | null;
        };
      }
    }),
  );

  // DB fallback numbers are only queried for the exchanges that need them.
  const fallbackIds = settled
    .filter((entry) => entry.fills === null)
    .map((entry) => entry.id);
  const fallbackNumbers = new Map<
    string,
    { total: number; byMonth: Map<string, number> }
  >();
  for (const id of fallbackIds) {
    try {
      fallbackNumbers.set(id, {
        total: await loadDbExchangeTotal(db, id, range),
        byMonth: await loadDbExchangeMonthly(
          db,
          id,
          range.from ?? new Date(Date.UTC(2020, 0, 1)),
        ),
      });
    } catch (error) {
      console.warn(
        "Exchange volume DB fallback failed; exchange contributes nothing",
        {
          exchangeId: id,
          message: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  const totals: ExchangeVolumeTotals = {
    totalUsd: 0,
    byExchange: [],
    byMonth: new Map(),
    exchangesFromDb: [],
  };
  for (const { id, fills } of settled) {
    if (fills === null) {
      const fallback = fallbackNumbers.get(id);
      if (!fallback) continue;
      totals.totalUsd += fallback.total;
      totals.byExchange.push({ exchangeId: id, usd: fallback.total });
      for (const [month, usd] of fallback.byMonth)
        totals.byMonth.set(month, (totals.byMonth.get(month) ?? 0) + usd);
      totals.exchangesFromDb.push(id);
      continue;
    }
    let usd = 0;
    for (const fill of fills) {
      if (range.from && fill.occurredAt < range.from) continue;
      if (range.to && fill.occurredAt >= range.to) continue;
      const notional = Number(fill.notionalUsd);
      if (!Number.isFinite(notional)) continue;
      usd += notional;
      const month = utcMonth(fill.occurredAt);
      totals.byMonth.set(month, (totals.byMonth.get(month) ?? 0) + notional);
    }
    totals.totalUsd += usd;
    totals.byExchange.push({ exchangeId: id, usd });
  }
  totals.byExchange.sort((left, right) => right.usd - left.usd);

  exchangeVolumeCache.set(cacheKey, {
    value: totals,
    expiresAt: Date.now() + EXCHANGE_VOLUME_CACHE_TTL_MS,
  });
  return totals;
}

function utcMonth(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** DB fallback total for ONE exchange over the requested range: reuses
 * loadVolumeTotals (volume-stats) and picks this exchange's row. Money
 * converts to number at the same boundary volume-stats uses. */
async function loadDbExchangeTotal(
  db: BotDatabase,
  exchangeId: string,
  range: ExchangeVolumeRange,
): Promise<number> {
  const volumeRange = range.from
    ? { from: range.from, ...(range.to ? { to: range.to } : {}) }
    : undefined;
  const totals = await loadVolumeTotals(db, volumeRange);
  return (
    totals.byExchange.find((entry) => entry.exchangeId === exchangeId)?.usd ??
    0
  );
}

/** DB fallback monthly breakdown for ONE exchange, attributed by trade
 * opening month — the same approximation loadMonthlyVolumeBreakdown
 * documents (volume-stats is not editable in this slice, and the fallback
 * needs a per-exchange split it does not expose). */
async function loadDbExchangeMonthly(
  db: BotDatabase,
  exchangeId: string,
  from: Date,
): Promise<Map<string, number>> {
  const monthExpr = sql<string>`date_format(${trades.createdAt}, '%Y-%m')`;
  const rows = await db
    .select({
      month: monthExpr,
      usd: sql<string>`coalesce(sum(${tradeLegs.filledNotionalUsd}), 0)`,
    })
    .from(tradeLegs)
    .innerJoin(trades, eq(tradeLegs.tradeId, trades.id))
    .where(and(eq(tradeLegs.exchangeId, exchangeId), gte(trades.createdAt, from)))
    .groupBy(monthExpr)
    .orderBy(monthExpr);
  return new Map(
    rows.map((row) => {
      const parsed = Number(row.usd);
      return [row.month, Number.isFinite(parsed) ? parsed : 0];
    }),
  );
}
