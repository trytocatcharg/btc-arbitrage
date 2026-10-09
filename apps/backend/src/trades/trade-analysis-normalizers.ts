import { formatDecimal, parseDecimal } from "@btc-arbitrage/domain";
import type { tradeLegs, signals } from "@btc-arbitrage/db";
import type {
  RawActiveUnhedgedTrade,
  RawTradeTimeline,
  RawUnhedgedEvent,
  UnhedgedResolution,
} from "./trade-analysis-service.js";

type TradeLegRow = typeof tradeLegs.$inferSelect;
type SignalRow = typeof signals.$inferSelect;

export interface UnhedgedActiveLegOpenDto {
  side: string;
  exchangeId: string;
  entryPriceUsd: string | null;
  quantityBase: string | null;
  quantityUsd: string | null;
  openedAt: string | null;
}

export interface UnhedgedActiveLegClosedDto {
  side: string;
  exchangeId: string;
  closeReason: string | null;
  closedAt: string | null;
  exitPriceUsd: string | null;
  realizedPnlUsd: string | null;
  entryFeeUsd: string | null;
  exitFeeUsd: string | null;
}

export interface UnhedgedActiveTradeDto {
  tradeId: number;
  symbol: string;
  longExchange: string;
  shortExchange: string;
  leverage: number;
  entrySpreadUsd: string | null;
  openedAt: string | null;
  unhedgedSince: string;
  unhedgedSinceApproximate: boolean;
  openLeg: UnhedgedActiveLegOpenDto | null;
  closedLeg: UnhedgedActiveLegClosedDto | null;
}

export interface UnhedgedActiveResponseDto {
  generatedAt: string;
  trades: UnhedgedActiveTradeDto[];
}

export interface UnhedgedEventLegDto {
  side: string;
  exchangeId: string;
  status: string;
  entryPriceUsd: string | null;
  exitPriceUsd: string | null;
  quantityBase: string | null;
  realizedPnlUsd: string | null;
  entryFeeUsd: string | null;
  exitFeeUsd: string | null;
  closeReason: string | null;
  closedAt: string | null;
}

export interface UnhedgedEventDto {
  tradeId: number;
  symbol: string;
  longExchange: string;
  shortExchange: string;
  leverage: number;
  windowStartAt: string | null;
  windowEndAt: string | null;
  durationMs: number | null;
  approximateStart: boolean;
  resolution: UnhedgedResolution;
  closeReason: string | null;
  legs: UnhedgedEventLegDto[];
  realizedPnlUsd: string | null;
  totalFeesUsd: string | null;
  netPnlUsd: string | null;
}

export interface UnhedgedEventsResponseDto {
  generatedAt: string;
  events: UnhedgedEventDto[];
}

export interface TradeTimelineTradeDto {
  id: number;
  signalId: number | null;
  symbol: string;
  marketType: string;
  mode: string;
  status: string;
  leverage: number;
  entrySpreadUsd: string | null;
  exitSpreadUsd: string | null;
  realizedPnlUsd: string | null;
  totalFeesUsd: string | null;
  unrealizedPnlUsd: string | null;
  openedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TradeTimelineStatusHistoryDto {
  id: number;
  fromStatus: string | null;
  toStatus: string;
  reason: string | null;
  changedAt: string;
}

/** Full tradeLegs row with dates normalized to ISO strings. */
export type TradeLegDto = Omit<
  TradeLegRow,
  "openedAt" | "closedAt" | "closureNotifiedAt"
> & {
  openedAt: string | null;
  closedAt: string | null;
  closureNotifiedAt: string | null;
};

/** Full signals row with dates normalized to ISO strings. */
export type SignalDto = Omit<SignalRow, "createdAt"> & {
  createdAt: string;
};

export interface TradeTimelineResponseDto {
  trade: TradeTimelineTradeDto;
  legs: TradeLegDto[];
  statusHistory: TradeTimelineStatusHistoryDto[];
  signal: SignalDto | null;
}

/**
 * Decimals pass through as raw SQL decimal strings; only dates are
 * normalized (toISOString). unhedgedSince priority (unhedged-observability
 * spec): monitor-written history row (exact) → closed leg's closedAt
 * (approximate) → trade updatedAt (approximate, pre-instrumentation).
 */
export function normalizeUnhedgedActive(
  generatedAt: Date,
  rawTrades: RawActiveUnhedgedTrade[],
): UnhedgedActiveResponseDto {
  return {
    generatedAt: generatedAt.toISOString(),
    trades: rawTrades.map((raw) => {
      const { trade, openLeg, closedLeg } = raw;
      const unhedgedSince = raw.unhedgedHistoryAt ?? closedLeg?.closedAt ?? trade.updatedAt;
      return {
        tradeId: trade.id,
        symbol: trade.symbol,
        longExchange: trade.longExchange,
        shortExchange: trade.shortExchange,
        leverage: trade.leverage,
        entrySpreadUsd: trade.entrySpreadUsd,
        openedAt: iso(trade.openedAt),
        unhedgedSince: unhedgedSince.toISOString(),
        unhedgedSinceApproximate: raw.unhedgedHistoryAt == null,
        openLeg: openLeg
          ? {
              side: openLeg.side,
              exchangeId: openLeg.exchangeId,
              entryPriceUsd: openLeg.entryPriceUsd,
              quantityBase: openLeg.quantityBase,
              quantityUsd: openLeg.quantityUsd,
              openedAt: iso(openLeg.openedAt),
            }
          : null,
        closedLeg: closedLeg
          ? {
              side: closedLeg.side,
              exchangeId: closedLeg.exchangeId,
              closeReason: closedLeg.closeReason,
              closedAt: iso(closedLeg.closedAt),
              exitPriceUsd: closedLeg.exitPriceUsd,
              realizedPnlUsd: closedLeg.realizedPnlUsd,
              entryFeeUsd: closedLeg.entryFeeUsd,
              exitFeeUsd: closedLeg.exitFeeUsd,
            }
          : null,
      };
    }),
  };
}

export function normalizeUnhedgedEvents(
  generatedAt: Date,
  rawEvents: RawUnhedgedEvent[],
): UnhedgedEventsResponseDto {
  return {
    generatedAt: generatedAt.toISOString(),
    events: rawEvents.map((raw) => {
      const { trade } = raw;
      return {
        tradeId: trade.id,
        symbol: trade.symbol,
        longExchange: trade.longExchange,
        shortExchange: trade.shortExchange,
        leverage: trade.leverage,
        windowStartAt: iso(raw.windowStartAt),
        windowEndAt: iso(raw.windowEndAt),
        durationMs:
          raw.windowStartAt != null && raw.windowEndAt != null
            ? raw.windowEndAt.getTime() - raw.windowStartAt.getTime()
            : null,
        approximateStart: raw.approximateStart,
        resolution: raw.resolution,
        closeReason: raw.closeReason,
        legs: raw.legs.map((leg) => ({
          side: leg.side,
          exchangeId: leg.exchangeId,
          status: leg.status,
          entryPriceUsd: leg.entryPriceUsd,
          exitPriceUsd: leg.exitPriceUsd,
          quantityBase: leg.quantityBase,
          realizedPnlUsd: leg.realizedPnlUsd,
          entryFeeUsd: leg.entryFeeUsd,
          exitFeeUsd: leg.exitFeeUsd,
          closeReason: leg.closeReason,
          closedAt: iso(leg.closedAt),
        })),
        realizedPnlUsd: trade.realizedPnlUsd,
        totalFeesUsd: trade.totalFeesUsd,
        // Net PnL convention (operator decision 2026-10-07): realized is
        // GROSS, net = realized − totalFeesUsd, and only when the trade
        // resolved AND the fee total is known (NULL fees are never
        // estimated).
        netPnlUsd:
          raw.resolution !== "open" &&
          trade.realizedPnlUsd != null &&
          trade.totalFeesUsd != null
            ? formatDecimal(
                parseDecimal(trade.realizedPnlUsd) -
                  parseDecimal(trade.totalFeesUsd),
                8,
              )
            : null,
      };
    }),
  };
}

export function normalizeTradeTimeline(
  raw: RawTradeTimeline,
): TradeTimelineResponseDto {
  const { trade } = raw;
  return {
    trade: {
      id: trade.id,
      signalId: trade.signalId,
      symbol: trade.symbol,
      marketType: trade.marketType,
      mode: trade.mode,
      status: trade.status,
      leverage: trade.leverage,
      entrySpreadUsd: trade.entrySpreadUsd,
      exitSpreadUsd: trade.exitSpreadUsd,
      realizedPnlUsd: trade.realizedPnlUsd,
      totalFeesUsd: trade.totalFeesUsd,
      unrealizedPnlUsd: trade.unrealizedPnlUsd,
      openedAt: iso(trade.openedAt),
      closedAt: iso(trade.closedAt),
      createdAt: trade.createdAt.toISOString(),
      updatedAt: trade.updatedAt.toISOString(),
    },
    legs: raw.legs.map((leg) => ({
      ...leg,
      openedAt: iso(leg.openedAt),
      closedAt: iso(leg.closedAt),
      closureNotifiedAt: iso(leg.closureNotifiedAt),
    })),
    statusHistory: raw.statusHistory.map((row) => ({
      id: row.id,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      reason: row.reason,
      changedAt: row.changedAt.toISOString(),
    })),
    signal: raw.signal
      ? { ...raw.signal, createdAt: raw.signal.createdAt.toISOString() }
      : null,
  };
}

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}
