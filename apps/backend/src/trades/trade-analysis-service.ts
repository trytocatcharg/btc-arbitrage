import {
  getDb,
  signals,
  tradeLegs,
  trades,
  tradeStatusHistory,
  unhedgedLegSamples,
} from "@btc-arbitrage/db";
import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";

type Db = Awaited<ReturnType<typeof getDb>>;

type TradeRow = typeof trades.$inferSelect;
type TradeLegRow = typeof tradeLegs.$inferSelect;
type TradeStatusHistoryRow = typeof tradeStatusHistory.$inferSelect;
type SignalRow = typeof signals.$inferSelect;

export type UnhedgedLegSampleRow = typeof unhedgedLegSamples.$inferSelect;

export type UnhedgedResolution = "open" | "closed" | "failed";

export interface RawActiveUnhedgedTrade {
  trade: TradeRow;
  openLeg: TradeLegRow | null;
  closedLeg: TradeLegRow | null;
  /** Latest monitor-written 'unhedged' history timestamp; null for
   * pre-instrumentation trades (the normalizer falls back to
   * approximations derived from leg/trade timestamps). */
  unhedgedHistoryAt: Date | null;
}

export interface RawUnhedgedEvent {
  trade: TradeRow;
  legs: TradeLegRow[];
  windowStartAt: Date | null;
  windowEndAt: Date | null;
  approximateStart: boolean;
  resolution: UnhedgedResolution;
  /** closeReason of the leg that was closed first. */
  closeReason: string | null;
}

export interface RawTradeTimeline {
  trade: TradeRow;
  legs: TradeLegRow[];
  statusHistory: TradeStatusHistoryRow[];
  signal: SignalRow | null;
}

export interface UnhedgedEventsQuery {
  limit: number;
  sinceDays: number;
}

/** Leg-closedAt gap that separates a real unhedged window from a normal
 * near-simultaneous hedged close (both TP/SL triggers fire together when
 * the move completes). Used only to reconstruct pre-instrumentation
 * windows from resolved trades that have no history rows. */
const MIN_RECONSTRUCTED_GAP_MINUTES = 5;

export interface TradeAnalysisService {
  getActiveUnhedgedTrades(): Promise<{
    generatedAt: Date;
    trades: RawActiveUnhedgedTrade[];
  }>;
  getUnhedgedEvents(query: UnhedgedEventsQuery): Promise<{
    generatedAt: Date;
    events: RawUnhedgedEvent[];
  }>;
  getTradeTimeline(tradeId: number): Promise<RawTradeTimeline | null>;
  getUnhedgedLegSamples(
    tradeId: number,
    query: { limit: number },
  ): Promise<{
    generatedAt: Date;
    tradeId: number;
    samples: UnhedgedLegSampleRow[];
  } | null>;
}

/**
 * Read-only trade analysis over the bot's database (unhedged-observability
 * spec). No exchange calls, no mutations: raw SQL rows leave decimals as
 * strings and dates as Date objects; normalization to the wire shape lives
 * in trade-analysis-normalizers.ts (volume-stats convention).
 */
export function createTradeAnalysisService(): TradeAnalysisService {
  return {
    async getActiveUnhedgedTrades() {
      const db = await getDb();
      const generatedAt = new Date();

      const tradeRows = await db
        .select()
        .from(trades)
        .where(eq(trades.status, "unhedged"))
        .orderBy(desc(trades.updatedAt));

      const tradeIds = tradeRows.map((trade) => trade.id);
      const legRows = tradeIds.length
        ? await db
            .select()
            .from(tradeLegs)
            .where(inArray(tradeLegs.tradeId, tradeIds))
        : [];
      const historyRows = tradeIds.length
        ? await db
            .select()
            .from(tradeStatusHistory)
            .where(
              and(
                inArray(tradeStatusHistory.tradeId, tradeIds),
                eq(tradeStatusHistory.toStatus, "unhedged"),
              ),
            )
        : [];

      const result: RawActiveUnhedgedTrade[] = tradeRows.map((trade) => {
        const legs = legRows.filter((leg) => leg.tradeId === trade.id);
        const closedLeg =
          legs.find((leg) => leg.status === "closed") ?? null;
        const openLeg =
          legs.find((leg) => leg.status !== "closed") ?? null;
        const unhedgedHistoryAt = latestChangedAt(
          historyRows.filter((row) => row.tradeId === trade.id),
        );
        return { trade, openLeg, closedLeg, unhedgedHistoryAt };
      });

      return { generatedAt, trades: result };
    },

    async getUnhedgedEvents({ limit, sinceDays }) {
      const db = await getDb();
      const generatedAt = new Date();
      const cutoff = new Date(
        generatedAt.getTime() - sinceDays * 24 * 60 * 60 * 1000,
      );

      // Primary source: monitor-written 'unhedged' history rows in the
      // window (trade_status_history_to_status_changed_at_idx). Keep the
      // latest start per trade — a trade can only be unhedged once in
      // practice, but the dedupe also defines the merge below.
      const startRows = await db
        .select()
        .from(tradeStatusHistory)
        .where(
          and(
            eq(tradeStatusHistory.toStatus, "unhedged"),
            gte(tradeStatusHistory.changedAt, cutoff),
          ),
        );
      const startByTrade = new Map<number, TradeStatusHistoryRow>();
      for (const row of startRows) {
        const existing = startByTrade.get(row.tradeId);
        if (!existing || row.changedAt > existing.changedAt)
          startByTrade.set(row.tradeId, row);
      }
      const historyTradeIds = [...startByTrade.keys()];

      // Window end: the earliest later history row closing the same trade.
      const endRows = historyTradeIds.length
        ? await db
            .select()
            .from(tradeStatusHistory)
            .where(
              and(
                inArray(tradeStatusHistory.tradeId, historyTradeIds),
                inArray(tradeStatusHistory.toStatus, ["closed", "failed"]),
              ),
            )
        : [];
      const endByTrade = new Map<number, TradeStatusHistoryRow>();
      for (const row of endRows) {
        const start = startByTrade.get(row.tradeId);
        if (!start || row.changedAt <= start.changedAt) continue;
        const existing = endByTrade.get(row.tradeId);
        if (!existing || row.changedAt < existing.changedAt)
          endByTrade.set(row.tradeId, row);
      }

      // Merge pre-instrumentation data: trades currently 'unhedged' with no
      // 'unhedged' history row (the monitor only started writing them after
      // unhedged-observability). Their window start is the closed leg's
      // closedAt and is flagged approximate by the normalizer.
      const openTradeRows = await db
        .select()
        .from(trades)
        .where(eq(trades.status, "unhedged"));

      // Trades with ANY 'unhedged' history row, at any time: the primary
      // source above only sees rows inside the cutoff, so this set is what
      // guarantees the reconstruction below never duplicates an
      // instrumented window.
      const instrumentedRows = await db
        .select({ tradeId: tradeStatusHistory.tradeId })
        .from(tradeStatusHistory)
        .where(eq(tradeStatusHistory.toStatus, "unhedged"));
      const instrumentedTradeIds = new Set(
        instrumentedRows.map((row) => row.tradeId),
      );

      // Reconstruct resolved pre-instrumentation windows: trades that
      // closed/failed with no history row, whose two legs closed far enough
      // apart that the survivor was naked in between. A normal hedged
      // close is near-simultaneous, so the closed-leg gap approximates the
      // window; start and end are flagged approximate by the normalizer.
      const resolvedTradeRows = await db
        .select()
        .from(trades)
        .where(inArray(trades.status, ["closed", "failed"]));
      const reconstructedTradeRows = resolvedTradeRows.filter(
        (trade) =>
          !instrumentedTradeIds.has(trade.id) &&
          !startByTrade.has(trade.id),
      );
      const reconstructedIds = reconstructedTradeRows.map(
        (trade) => trade.id,
      );
      const reconstructedLegRows = reconstructedIds.length
        ? await db
            .select()
            .from(tradeLegs)
            .where(inArray(tradeLegs.tradeId, reconstructedIds))
        : [];
      const reconstructedWindows = reconstructedTradeRows.flatMap((trade) => {
        const legs = reconstructedLegRows.filter(
          (leg) => leg.tradeId === trade.id,
        );
        const first = firstClosedLeg(legs);
        const last = lastClosedLeg(legs);
        if (!first?.closedAt || !last?.closedAt) return [];
        const gapMs = last.closedAt.getTime() - first.closedAt.getTime();
        if (gapMs < MIN_RECONSTRUCTED_GAP_MINUTES * 60_000) return [];
        if (first.closedAt < cutoff) return [];
        return [{ trade, legs, first, last }];
      });

      const fallbackTradeIds = openTradeRows.flatMap((trade) =>
        !startByTrade.has(trade.id) && !instrumentedTradeIds.has(trade.id)
          ? [trade.id]
          : [],
      );

      const allTradeIds = [...historyTradeIds, ...fallbackTradeIds];
      const closedTradeRows = historyTradeIds.length
        ? await db
            .select()
            .from(trades)
            .where(inArray(trades.id, historyTradeIds))
        : [];
      const tradeById = new Map<number, TradeRow>();
      for (const trade of openTradeRows) tradeById.set(trade.id, trade);
      for (const trade of closedTradeRows) tradeById.set(trade.id, trade);

      const legRows = allTradeIds.length
        ? await db
            .select()
            .from(tradeLegs)
            .where(inArray(tradeLegs.tradeId, allTradeIds))
        : [];

      const events: RawUnhedgedEvent[] = [];
      for (const [tradeId, start] of startByTrade) {
        const trade = tradeById.get(tradeId);
        if (!trade) continue;
        const legs = legRows.filter((leg) => leg.tradeId === tradeId);
        const end = endByTrade.get(tradeId) ?? null;
        events.push({
          trade,
          legs,
          windowStartAt: start.changedAt,
          windowEndAt: end?.changedAt ?? null,
          approximateStart: false,
          resolution: end ? (end.toStatus as UnhedgedResolution) : "open",
          closeReason: firstClosedLeg(legs)?.closeReason ?? null,
        });
      }
      for (const tradeId of fallbackTradeIds) {
        const trade = tradeById.get(tradeId);
        if (!trade) continue;
        const legs = legRows.filter((leg) => leg.tradeId === tradeId);
        const firstClosed = firstClosedLeg(legs);
        events.push({
          trade,
          legs,
          windowStartAt: firstClosed?.closedAt ?? null,
          windowEndAt: null,
          approximateStart: true,
          resolution: "open",
          closeReason: firstClosed?.closeReason ?? null,
        });
      }
      for (const window of reconstructedWindows) {
        events.push({
          trade: window.trade,
          legs: window.legs,
          windowStartAt: window.first.closedAt,
          windowEndAt: window.last.closedAt,
          approximateStart: true,
          resolution: window.trade.status as UnhedgedResolution,
          closeReason: window.first.closeReason,
        });
      }

      events.sort((a, b) => {
        const aStart = a.windowStartAt ?? a.trade.updatedAt;
        const bStart = b.windowStartAt ?? b.trade.updatedAt;
        return bStart.getTime() - aStart.getTime();
      });
      return { generatedAt, events: events.slice(0, limit) };
    },

    async getTradeTimeline(tradeId) {
      const db = await getDb();
      const tradeRows = await db
        .select()
        .from(trades)
        .where(eq(trades.id, tradeId))
        .limit(1);
      const trade = tradeRows[0];
      if (!trade) return null;

      const legs = await db
        .select()
        .from(tradeLegs)
        .where(eq(tradeLegs.tradeId, tradeId));
      const statusHistory = await db
        .select()
        .from(tradeStatusHistory)
        .where(eq(tradeStatusHistory.tradeId, tradeId))
        .orderBy(asc(tradeStatusHistory.changedAt), asc(tradeStatusHistory.id));
      const signal =
        trade.signalId == null
          ? null
          : ((await db
              .select()
              .from(signals)
              .where(eq(signals.id, trade.signalId))
              .limit(1))[0] ?? null);

      return { trade, legs, statusHistory, signal };
    },

    async getUnhedgedLegSamples(tradeId, { limit }) {
      const db = await getDb();
      const generatedAt = new Date();
      const tradeRows = await db
        .select({ id: trades.id })
        .from(trades)
        .where(eq(trades.id, tradeId))
        .limit(1);
      if (!tradeRows[0]) return null;

      const sampleRows = await db
        .select()
        .from(unhedgedLegSamples)
        .where(eq(unhedgedLegSamples.tradeId, tradeId))
        .orderBy(asc(unhedgedLegSamples.sampledAt), asc(unhedgedLegSamples.id))
        .limit(limit);

      return { generatedAt, tradeId, samples: sampleRows };
    },
  };
}

function latestChangedAt(rows: TradeStatusHistoryRow[]): Date | null {
  let latest: Date | null = null;
  for (const row of rows) {
    if (!latest || row.changedAt > latest) latest = row.changedAt;
  }
  return latest;
}

/** Leg with the earliest valid closedAt; null when no leg has properly
 * closed. Zero-dates ('0000-00-00', pre-monitor era) parse into invalid
 * Date objects, not null — they must not count as closures. */
function firstClosedLeg(legs: TradeLegRow[]): TradeLegRow | null {
  let first: TradeLegRow | null = null;
  for (const leg of legs) {
    const closedAt = validClosedAt(leg);
    if (closedAt == null) continue;
    if (!first || closedAt < validClosedAt(first)!) first = leg;
  }
  return first;
}

/** Leg with the latest valid closedAt; null when no leg has properly
 * closed. Same zero-date guard as firstClosedLeg. */
function lastClosedLeg(legs: TradeLegRow[]): TradeLegRow | null {
  let last: TradeLegRow | null = null;
  for (const leg of legs) {
    const closedAt = validClosedAt(leg);
    if (closedAt == null) continue;
    if (!last || closedAt > validClosedAt(last)!) last = leg;
  }
  return last;
}

/** The leg's closedAt only when it is a real timestamp — zero-dates from
 * the pre-monitor era parse into invalid Date objects that must be treated
 * as "not closed" by the window reconstruction. */
function validClosedAt(leg: TradeLegRow): Date | null {
  if (leg.closedAt == null || Number.isNaN(leg.closedAt.getTime()))
    return null;
  return leg.closedAt;
}
