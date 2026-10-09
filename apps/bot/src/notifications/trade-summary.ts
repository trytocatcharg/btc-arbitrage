import { and, desc, inArray, isNotNull } from "drizzle-orm";
import { getDb, tradeLegs, trades, openTradeStatuses } from "@btc-arbitrage/db";
import type { ExchangeAdapter } from "@btc-arbitrage/exchange-core";
import type { MarketType, PriceSource } from "@btc-arbitrage/domain";

type BotDatabase = Awaited<ReturnType<typeof getDb>>;
type TradeRow = typeof trades.$inferSelect;
type TradeLegRow = typeof tradeLegs.$inferSelect;

export interface ExchangeRegistryLike {
  get(id: string): ExchangeAdapter;
}

export interface TradeSummaryDependencies {
  db: BotDatabase;
  registry: ExchangeRegistryLike;
}

interface ResolvedTradeSummary {
  id: number;
  status: string;
  symbol: string;
  createdAt: Date;
  openedAt: Date | null;
  updatedAt: Date;
  entrySpreadUsd: number | null;
  liveSpreadUsd: number | null;
  totalEstimatedPnlUsd: number | null;
  /** Sum of known entry+exit fees across legs; null when none known. */
  totalKnownFeesUsd: number | null;
  /** totalEstimatedPnlUsd minus known fees; null when no fees known. */
  totalNetPnlUsd: number | null;
  longLeg: ResolvedLegSummary;
  shortLeg: ResolvedLegSummary;
  notes: string[];
}

interface ResolvedLegSummary {
  exchangeId: string;
  status: string;
  side: "long" | "short";
  entryPriceUsd: number | null;
  quantityBase: number | null;
  currentPriceUsd: number | null;
  estimatedPnlUsd: number | null;
  /** Closed legs only: exit price and realized GROSS PnL (fee-free). */
  exitPriceUsd: number | null;
  realizedGrossPnlUsd: number | null;
  /** Closed legs only: sum of known entry+exit fees; null when none known. */
  knownFeesUsd: number | null;
  quoteError?: string;
}

interface QuoteSnapshot {
  priceUsd: number;
}

export async function buildTradeSummaryMessage(
  deps: TradeSummaryDependencies,
): Promise<string> {
  const activeTrades = await loadActiveTrades(deps.db);
  if (activeTrades.length === 0) {
    return "📭 No active trades found.";
  }

  const legsByTradeId = await loadTradeLegsByTradeId(
    deps.db,
    activeTrades.map((trade) => trade.id),
  );
  const quoteCache = new Map<string, Promise<QuoteSnapshot | QuoteError>>();

  const summaries = await Promise.all(
    activeTrades.map(async (trade) => {
      const legs = legsByTradeId.get(trade.id) ?? [];
      return buildTradeSummary(trade, legs, deps.registry, quoteCache);
    }),
  );

  return formatTradeSummaryMessage(summaries);
}

/** True when at least one trade is in an active (openTradeStatuses) state.
 * Same filter as buildTradeSummaryMessage, so the panel button and the
 * summary never disagree about what "active" means. */
export async function hasActiveTrades(db: BotDatabase): Promise<boolean> {
  const rows = await db
    .select({ id: trades.id })
    .from(trades)
    .where(inArray(trades.status, [...openTradeStatuses]))
    .limit(1);
  return rows.length > 0;
}

export interface LastTradesDependencies {
  db: BotDatabase;
}

/** Compact per-trade PnL history: one line per CLOSED trade that has a
 * valid realized PnL (positive or negative). Active, cancelled, and
 * failed trades never appear here (operator decision 2026-10-09).
 * Net = realized GROSS − total fees (operator convention 2026-10-07).
 * Timestamps render in the operator's IANA timezone. */
export async function buildLastTradesMessage(
  deps: LastTradesDependencies,
  timeZone: string,
  limit = 10,
): Promise<string> {
  const rows = await deps.db
    .select()
    .from(trades)
    .where(and(inArray(trades.status, ["closed"]), isNotNull(trades.realizedPnlUsd)))
    .orderBy(desc(trades.closedAt))
    .limit(limit);

  if (rows.length === 0) {
    return "📭 No closed trades with PnL yet.";
  }

  const lines: string[] = [`📜 Last ${rows.length} trades (closed)`, ""];
  let totalNetUsd = 0;
  for (const trade of rows) {
    const netUsd = tradeNetPnlUsd(trade);
    if (netUsd == null) continue;
    totalNetUsd += netUsd;
    const when = trade.closedAt ?? trade.createdAt;
    lines.push(
      `#${trade.id} · ${formatClosedAt(when, timeZone)} · ${formatPnl(netUsd)}`,
    );
  }
  lines.push("");
  lines.push(`Total net: ${formatPnl(totalNetUsd)}`);
  return lines.join("\n");
}

/** Closed-at label in the operator's timezone: YYYY-MM-DD, short weekday
 * name, HH:MM (operator request 2026-10-09: fecha, día, hora, minutos). */
function formatClosedAt(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("es-AR", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")} ${value("weekday")} ${value("hour")}:${value("minute")}`;
}

/** Net PnL for a terminal trade: realized GROSS minus total fees.
 * Null when the trade never recorded realized PnL. */
function tradeNetPnlUsd(trade: TradeRow): number | null {
  const realized = toNumber(trade.realizedPnlUsd);
  if (realized == null) return null;
  const fees = toNumber(trade.totalFeesUsd);
  return fees != null ? realized - fees : realized;
}

async function loadActiveTrades(db: BotDatabase): Promise<TradeRow[]> {
  return db
    .select()
    .from(trades)
    .where(inArray(trades.status, [...openTradeStatuses]))
    .orderBy(desc(trades.openedAt), desc(trades.createdAt));
}

async function loadTradeLegsByTradeId(
  db: BotDatabase,
  tradeIds: number[],
): Promise<Map<number, TradeLegRow[]>> {
  const byTradeId = new Map<number, TradeLegRow[]>();
  if (tradeIds.length === 0) return byTradeId;

  const rows = await db
    .select()
    .from(tradeLegs)
    .where(inArray(tradeLegs.tradeId, tradeIds));
  for (const row of rows) {
    const current = byTradeId.get(row.tradeId) ?? [];
    current.push(row);
    byTradeId.set(row.tradeId, current);
  }
  return byTradeId;
}

async function buildTradeSummary(
  trade: TradeRow,
  tradeLegRows: TradeLegRow[],
  registry: ExchangeRegistryLike,
  quoteCache: Map<string, Promise<QuoteSnapshot | QuoteError>>,
): Promise<ResolvedTradeSummary> {
  const longLegRow = tradeLegRows.find((leg) => leg.side === "long");
  const shortLegRow = tradeLegRows.find((leg) => leg.side === "short");

  const [longQuote, shortQuote] = await Promise.all([
    longLegRow
      ? fetchCurrentQuote(registry, trade, longLegRow.exchangeId, quoteCache)
      : Promise.resolve<QuoteError>({ error: "Missing long leg row" }),
    shortLegRow
      ? fetchCurrentQuote(registry, trade, shortLegRow.exchangeId, quoteCache)
      : Promise.resolve<QuoteError>({ error: "Missing short leg row" }),
  ]);

  const longLeg = resolveLegSummary(longLegRow, longQuote, "long");
  const shortLeg = resolveLegSummary(shortLegRow, shortQuote, "short");
  const entrySpreadUsd = resolveEntrySpreadUsd(trade, longLegRow, shortLegRow);
  const liveSpreadUsd =
    longLeg.currentPriceUsd != null && shortLeg.currentPriceUsd != null
      ? shortLeg.currentPriceUsd - longLeg.currentPriceUsd
      : null;

  // Effective leg PnL: realized GROSS for closed legs, live estimate for
  // open ones. Never mixes the two within a leg.
  const effectiveLegPnl = (leg: ResolvedLegSummary): number | null =>
    leg.realizedGrossPnlUsd ?? leg.estimatedPnlUsd;
  const longEffectivePnl = effectiveLegPnl(longLeg);
  const shortEffectivePnl = effectiveLegPnl(shortLeg);
  const totalEstimatedPnlUsd =
    longEffectivePnl != null && shortEffectivePnl != null
      ? longEffectivePnl + shortEffectivePnl
      : toNumber(trade.unrealizedPnlUsd);
  const totalKnownFeesUsd = [longLeg.knownFeesUsd, shortLeg.knownFeesUsd].reduce<
    number | null
  >((total, fees) => (fees != null ? (total ?? 0) + fees : total), null);
  const totalNetPnlUsd =
    totalEstimatedPnlUsd != null && totalKnownFeesUsd != null
      ? totalEstimatedPnlUsd - totalKnownFeesUsd
      : null;

  const notes: string[] = [];
  if (!longLegRow) notes.push("Long leg row missing in DB.");
  if (!shortLegRow) notes.push("Short leg row missing in DB.");
  if (longLeg.quoteError)
    notes.push(`Long quote unavailable: ${longLeg.quoteError}`);
  if (shortLeg.quoteError)
    notes.push(`Short quote unavailable: ${shortLeg.quoteError}`);

  return {
    id: trade.id,
    status: trade.status,
    symbol: trade.symbol,
    createdAt: trade.createdAt,
    openedAt: trade.openedAt ?? null,
    updatedAt: trade.updatedAt,
    entrySpreadUsd,
    liveSpreadUsd,
    totalEstimatedPnlUsd,
    totalKnownFeesUsd,
    totalNetPnlUsd,
    longLeg,
    shortLeg,
    notes,
  };
}

async function fetchCurrentQuote(
  registry: ExchangeRegistryLike,
  trade: TradeRow,
  exchangeId: string,
  quoteCache: Map<string, Promise<QuoteSnapshot | QuoteError>>,
): Promise<QuoteSnapshot | QuoteError> {
  const cacheKey = `${exchangeId}|${trade.symbol}|${trade.marketType}|${trade.priceSource}`;
  const cached = quoteCache.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    try {
      const adapter = registry.get(exchangeId);
      const snapshot = await adapter.getPriceSnapshot({
        symbol: trade.symbol,
        marketType: trade.marketType as MarketType,
        priceSource: trade.priceSource as PriceSource,
      });
      const price = toNumber(snapshot.priceUsd);
      if (price == null) {
        return {
          error: `Invalid price ${snapshot.priceUsd}`,
        } satisfies QuoteError;
      }
      return { priceUsd: price } satisfies QuoteSnapshot;
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Unknown quote error",
      } satisfies QuoteError;
    }
  })();

  quoteCache.set(cacheKey, promise);
  return promise;
}

function resolveLegSummary(
  leg: TradeLegRow | undefined,
  quote: QuoteSnapshot | QuoteError,
  side: "long" | "short",
): ResolvedLegSummary {
  const entryPriceUsd = leg ? toNumber(leg.entryPriceUsd) : null;
  const quantityBase = resolveQuantityBase(leg);
  const currentPriceUsd = "priceUsd" in quote ? quote.priceUsd : null;
  const estimatedPnlUsd =
    entryPriceUsd != null && quantityBase != null && currentPriceUsd != null
      ? side === "long"
        ? (currentPriceUsd - entryPriceUsd) * quantityBase
        : (entryPriceUsd - currentPriceUsd) * quantityBase
      : null;

  const closed = leg?.status === "closed";
  const exitPriceUsd = leg ? toNumber(leg.exitPriceUsd) : null;
  const realizedGrossPnlUsd = closed
    ? deriveClosedLegGrossPnlUsd(leg, side, entryPriceUsd, exitPriceUsd, quantityBase)
    : null;
  const knownFeesUsd = closed && leg ? knownLegFeesUsd(leg) : null;

  return {
    exchangeId: leg?.exchangeId ?? "unknown",
    status: leg?.status ?? "missing",
    side,
    entryPriceUsd,
    quantityBase,
    currentPriceUsd,
    estimatedPnlUsd,
    exitPriceUsd: closed ? exitPriceUsd : null,
    realizedGrossPnlUsd,
    knownFeesUsd,
    quoteError: "error" in quote ? quote.error : undefined,
  };
}

/** Exchange-agnostic GROSS realized PnL for a closed leg, mirroring the
 * convention in trade-monitor.ts (operator decision 2026-10-07): derived
 * from entry/exit/qty; the venue-reported realizedPnlUsd is only a fallback
 * because its fee convention varies by exchange (Arcus nets the exit fee
 * into it; Extended reports none at all). */
function deriveClosedLegGrossPnlUsd(
  leg: TradeLegRow | undefined,
  side: "long" | "short",
  entryPriceUsd: number | null,
  exitPriceUsd: number | null,
  quantityBase: number | null,
): number | null {
  if (entryPriceUsd != null && exitPriceUsd != null && quantityBase != null) {
    return (
      (exitPriceUsd - entryPriceUsd) *
      quantityBase *
      (side === "long" ? 1 : -1)
    );
  }
  return leg?.realizedPnlUsd != null ? toNumber(leg.realizedPnlUsd) : null;
}

/** Sum of the leg's KNOWN fees (entry + exit); null when none are known.
 * Fees are never estimated. Mirrors trade-monitor.ts. */
function knownLegFeesUsd(leg: TradeLegRow): number | null {
  let feesUsd = 0;
  let seen = false;
  for (const fee of [toNumber(leg.entryFeeUsd), toNumber(leg.exitFeeUsd)]) {
    if (fee == null) continue;
    feesUsd += fee;
    seen = true;
  }
  return seen ? feesUsd : null;
}

function resolveQuantityBase(leg: TradeLegRow | undefined): number | null {
  if (!leg) return null;
  const explicitQuantity = toNumber(leg.quantityBase);
  if (explicitQuantity != null) return explicitQuantity;

  const quantityUsd = toNumber(leg.quantityUsd);
  const entryPrice = toNumber(leg.entryPriceUsd);
  if (quantityUsd != null && entryPrice != null && entryPrice > 0) {
    return quantityUsd / entryPrice;
  }
  return null;
}

function resolveEntrySpreadUsd(
  trade: TradeRow,
  longLeg: TradeLegRow | undefined,
  shortLeg: TradeLegRow | undefined,
): number | null {
  const storedEntrySpread = toNumber(trade.entrySpreadUsd);
  if (storedEntrySpread != null) return storedEntrySpread;

  const longEntry = toNumber(longLeg?.entryPriceUsd);
  const shortEntry = toNumber(shortLeg?.entryPriceUsd);
  if (longEntry == null || shortEntry == null) return null;
  return shortEntry - longEntry;
}

function formatTradeSummaryMessage(summaries: ResolvedTradeSummary[]): string {
  const globalEstimatedPnlUsd = summaries.reduce<number | null>(
    (total, summary) => {
      if (summary.totalEstimatedPnlUsd == null) return total;
      return (total ?? 0) + summary.totalEstimatedPnlUsd;
    },
    null,
  );
  const lines: string[] = ["📊 Active trade summary"];

  lines.push(`Open trades: ${summaries.length}`);
  lines.push(`Global estimated PnL: ${formatPnl(globalEstimatedPnlUsd)}`);
  const globalKnownFeesUsd = summaries.reduce<number | null>(
    (total, summary) =>
      summary.totalKnownFeesUsd != null
        ? (total ?? 0) + summary.totalKnownFeesUsd
        : total,
    null,
  );
  if (globalEstimatedPnlUsd != null && globalKnownFeesUsd != null) {
    lines.push(
      `Global net (known fees): ${formatPnl(globalEstimatedPnlUsd - globalKnownFeesUsd)}`,
    );
  }

  for (const summary of summaries) {
    lines.push("");
    lines.push(`Trade #${summary.id} · ${summary.symbol} · ${summary.status}`);
    lines.push(
      `Created: ${formatDate(summary.createdAt)}${summary.openedAt ? ` · Opened: ${formatDate(summary.openedAt)}` : ""}`,
    );

    if (summary.entrySpreadUsd != null) {
      lines.push(`Entry spread: ${formatSignedUsd(summary.entrySpreadUsd)}`);
    }
    if (summary.liveSpreadUsd != null) {
      lines.push(`Live spread: ${formatSignedUsd(summary.liveSpreadUsd)}`);
    }
    if (summary.totalEstimatedPnlUsd != null) {
      lines.push(
        `Trade estimated PnL: ${formatPnl(summary.totalEstimatedPnlUsd)}`,
      );
    }
    if (summary.totalNetPnlUsd != null) {
      lines.push(`Trade net (known fees): ${formatPnl(summary.totalNetPnlUsd)}`);
    }

    lines.push("");
    lines.push(formatLegSummary(summary.longLeg));
    lines.push("");
    lines.push(formatLegSummary(summary.shortLeg));

    if (summary.notes.length > 0) {
      lines.push("");
      for (const note of summary.notes) {
        lines.push(`• ${note}`);
      }
    }
  }

  return lines.join("\n");
}

function formatLegSummary(leg: ResolvedLegSummary): string {
  const label = leg.side.toUpperCase();
  const lines = [
    `${label} ${leg.exchangeId}`,
    `Status: ${leg.status}`,
    `Entry: ${formatUsd(leg.entryPriceUsd)}`,
  ];

  // Closed legs report the realized exit, never a live-mark estimate: the
  // venue mark is irrelevant once the position no longer exists, and the
  // estimate both misses the real exit price and ignores fees.
  if (leg.status === "closed") {
    lines.push(`Exit: ${formatUsd(leg.exitPriceUsd)}`);
    lines.push(`Leg PnL: ${formatPnl(leg.realizedGrossPnlUsd)}`);
    if (leg.realizedGrossPnlUsd != null && leg.knownFeesUsd != null) {
      lines.push(
        `Fees: $${leg.knownFeesUsd.toFixed(2)} · Net: ${formatPnl(leg.realizedGrossPnlUsd - leg.knownFeesUsd)}`,
      );
    }
    return lines.join("\n");
  }

  const currentPriceUsd = leg.currentPriceUsd;
  const priceMoveUsd =
    leg.entryPriceUsd != null && currentPriceUsd != null
      ? currentPriceUsd - leg.entryPriceUsd
      : null;
  const priceMovePercent =
    leg.entryPriceUsd != null && priceMoveUsd != null
      ? (priceMoveUsd / leg.entryPriceUsd) * 100
      : null;
  lines.push(`Current: ${formatUsd(currentPriceUsd)}`);

  if (priceMoveUsd != null) {
    lines.push(
      `Price move: ${formatSignedUsd(priceMoveUsd)} (${formatSignedPercent(priceMovePercent)})`,
    );
  }

  lines.push(`Leg PnL: ${formatPnl(leg.estimatedPnlUsd)}`);
  if (leg.quoteError) {
    lines.push(`Quote error: ${leg.quoteError}`);
  }

  return lines.join("\n");
}

function formatDate(value: Date): string {
  return value
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "Z");
}

function formatUsd(value: number | null): string {
  if (value == null) return "n/a";
  return `$${value.toFixed(2)}`;
}

function formatSignedUsd(value: number | null): string {
  if (value == null) return "n/a";
  const prefix = value >= 0 ? "+" : "-";
  return `${prefix}$${Math.abs(value).toFixed(2)}`;
}

function formatSignedPercent(value: number | null): string {
  if (value == null) return "n/a";
  const prefix = value >= 0 ? "+" : "-";
  return `${prefix}${Math.abs(value).toFixed(2)}%`;
}

function formatPnl(value: number | null): string {
  if (value == null) return "n/a";
  const icon = value >= 0 ? "🟢" : "🔴";
  return `${icon} ${formatSignedUsd(value)}`;
}

function toNumber(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

interface QuoteError {
  error: string;
}
