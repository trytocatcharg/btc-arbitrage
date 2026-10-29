export type ExchangeId = "risex" | "extended" | "arcus" | "variational" | "qfex";
export type MarketType = "perpetual" | "futures";
export type PriceSource = "mark" | "index" | "last";
export type OrderSide = "long" | "short";
export type ExchangeBalanceStatus = "available" | "unconfigured" | "error";
export enum ExecutionMode {
  DryRun = "dry-run",
  Live = "live",
}
export type SignalStatus = "created" | "notified" | "failed" | "ignored";
export type OperationStatus = "dry_run" | "blocked" | "submitted" | "failed";
export type EventLevel = "debug" | "info" | "warn" | "error";

export interface PriceSnapshot {
  id?: string;
  exchangeId: ExchangeId;
  symbol: string;
  externalMarketId?: string;
  marketType: MarketType;
  priceSource: PriceSource;
  priceUsd: string;
  bidUsd?: string;
  askUsd?: string;
  exchangeTimestamp: Date;
  receivedAt: Date;
  raw?: unknown;
}

export interface SpreadSnapshot {
  id?: string;
  symbol: string;
  marketType: MarketType;
  priceSource: PriceSource;
  exchangeA: ExchangeId;
  exchangeB: ExchangeId;
  exchangeAPriceUsd: string;
  exchangeBPriceUsd: string;
  absoluteDiffUsd: string;
  diffBps: string;
  direction: "a_above_b" | "b_above_a" | "flat";
  thresholdUsd: string;
  thresholdMatched: boolean;
  calculatedAt: Date;
}

export interface TradingSignal {
  id?: string;
  spreadId?: string;
  symbol: string;
  marketType: MarketType;
  priceSource: PriceSource;
  exchangeA: ExchangeId;
  exchangeB: ExchangeId;
  longExchange: ExchangeId;
  shortExchange: ExchangeId;
  exchangeAPriceUsd: string;
  exchangeBPriceUsd: string;
  absoluteDiffUsd: string;
  thresholdUsd: string;
  leverage: number;
  reason: string;
  status: SignalStatus;
  createdAt: Date;
}

export interface Operation {
  id?: string;
  signalId?: string;
  mode: ExecutionMode;
  symbol: string;
  leverage: number;
  status: OperationStatus;
  guardrailReason?: string;
  legs?: Array<{
    exchangeId: ExchangeId;
    side: OrderSide;
    plannedPriceUsd?: string;
  }>;
  createdAt: Date;
}

export interface ExchangeBalance {
  exchangeId: ExchangeId;
  displayName: string;
  asset: string;
  status: ExchangeBalanceStatus;
  totalEquityUsd: string | null;
  availableUsd: string | null;
  marginUsedUsd: string | null;
  unrealizedPnlUsd: string | null;
  source: string;
  syntheticZeroBalance?: boolean;
  message?: string;
  receivedAt: string;
}

export interface ExchangeBalancesResponse {
  generatedAt: string;
  balances: ExchangeBalance[];
  total: string | null;
}

export interface EventRecord {
  id?: string;
  level: EventLevel;
  type: string;
  message: string;
  relatedEntityId?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

/** A strategy pair the operator can select at runtime. `symbol` is the
 * canonical bot symbol (normalized, quote included, e.g. "NVDAUSDT");
 * each exchange resolves it to its native market name through base-asset
 * matching in findMarket() (RISEx lists "NVDA", Extended/Arcus "NVDA-USD"),
 * so no per-exchange mapping table is needed. Adding a pair = one entry here:
 * the Telegram Pairs panel and the runtime applier both render/validate
 * from this catalog. */
export interface TradingPair {
  /** Operator-facing label, e.g. "BTC/USD". */
  label: string;
  /** Canonical bot symbol stored in config.btcSymbol and per-row in the DB. */
  symbol: string;
}

export const DEFAULT_TRADING_PAIR_SYMBOL = "BTCUSDT";

/** Symbol stored on gold/silver ratio trades (`trades.symbol` = "GOLDSILVER",
 * both legs on Arcus GLD-USD / SLV-USD). It is NOT a selectable trading
 * pair: since gold-silver-decouple the metal strategy is opened on demand
 * from the Telegram /ratio command and coexists with the active spread
 * pair, and no spread-exchange adapter ever resolves this symbol. */
export const GOLD_SILVER_SYMBOL = "GOLDSILVER";

export const TRADING_PAIRS: readonly TradingPair[] = [
  { label: "BTC/USD", symbol: "BTCUSDT" },
  { label: "ETH/USD", symbol: "ETHUSDT" },
  { label: "NVDA/USD", symbol: "NVDAUSDT" },
];

export function findTradingPair(
  symbol: string,
): TradingPair | undefined {
  const target = symbol.trim().toUpperCase();
  return TRADING_PAIRS.find((pair) => pair.symbol === target);
}

export function isSupportedTradingSymbol(symbol: string): boolean {
  return findTradingPair(symbol) !== undefined;
}

export interface CalculateSpreadInput {
  exchangeA: PriceSnapshot;
  exchangeB: PriceSnapshot;
  thresholdUsd: string;
  calculatedAt?: Date;
}

export function calculateSpread(input: CalculateSpreadInput): SpreadSnapshot {
  const a = parseDecimal(input.exchangeA.priceUsd, "exchangeA.priceUsd");
  const b = parseDecimal(input.exchangeB.priceUsd, "exchangeB.priceUsd");
  const threshold = parseDecimal(input.thresholdUsd, "thresholdUsd");
  const diff = a - b;
  const absoluteDiff = Math.abs(diff);
  const midpoint = (a + b) / 2;
  const diffBps = midpoint === 0 ? 0 : (absoluteDiff / midpoint) * 10_000;

  return {
    symbol: input.exchangeA.symbol,
    marketType: input.exchangeA.marketType,
    priceSource: input.exchangeA.priceSource,
    exchangeA: input.exchangeA.exchangeId,
    exchangeB: input.exchangeB.exchangeId,
    exchangeAPriceUsd: formatDecimal(a),
    exchangeBPriceUsd: formatDecimal(b),
    absoluteDiffUsd: formatDecimal(absoluteDiff),
    diffBps: formatDecimal(diffBps, 4),
    direction: diff > 0 ? "a_above_b" : diff < 0 ? "b_above_a" : "flat",
    thresholdUsd: formatDecimal(threshold),
    thresholdMatched: absoluteDiff >= threshold,
    calculatedAt: input.calculatedAt ?? new Date(),
  };
}

export type MetalRatioSide = "short_gold_long_silver" | "long_gold_short_silver";

/** Gold/silver ratio from USD-denominated perp prices. Throws on an invalid
 * or non-positive silver price (division by zero / negative denominator). */
export function computeMetalRatio(
  goldPriceUsd: string,
  silverPriceUsd: string,
): string {
  const gold = parseDecimal(goldPriceUsd, "goldPriceUsd");
  const silver = parseDecimal(silverPriceUsd, "silverPriceUsd");
  if (silver <= 0) {
    throw new Error(
      "silverPriceUsd must be positive to compute the gold/silver ratio",
    );
  }
  return formatDecimal(gold / silver);
}

/** Wilder-smoothed RSI over decimal-string closes (oldest first). Returns
 * undefined when there are not enough closes (closes.length <= period).
 * A series with zero average loss resolves to 100 (all gains), or 50 when
 * the series is completely flat (no gains and no losses). */
export function computeRsi(
  closes: readonly string[],
  period: number,
): string | undefined {
  if (!Number.isInteger(period) || period < 2) {
    throw new Error("period must be an integer >= 2");
  }
  if (closes.length <= period) return undefined;
  const values = closes.map((close, index) =>
    parseDecimal(close, `closes[${index}]`),
  );

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) gainSum += change;
    else lossSum += -change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return formatDecimal(avgGain === 0 ? 50 : 100, 4);
  const rs = avgGain / avgLoss;
  return formatDecimal(100 - 100 / (1 + rs), 4);
}

/** Maps an RSI value to the mean-reversion side of the ratio trade: RSI
 * >= 50 + band => ratio overbought => short gold / long silver; RSI <= 50 -
 * band => ratio oversold => long gold / short silver. Returns undefined
 * inside the dead zone around 50. */
export function rsiToSide(rsi: string, band: string): MetalRatioSide | undefined {
  const value = parseDecimal(rsi, "rsi");
  const bandValue = parseDecimal(band, "band");
  if (bandValue < 0) throw new Error("band must be >= 0");
  if (value >= 50 + bandValue) return "short_gold_long_silver";
  if (value <= 50 - bandValue) return "long_gold_short_silver";
  return undefined;
}

export function parseDecimal(value: string, fieldName = "decimal"): number {
  if (!/^[-+]?\d+(\.\d+)?$/.test(value.trim())) {
    throw new Error(`${fieldName} must be a decimal string`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldName} must be finite`);
  }
  return parsed;
}

export function formatDecimal(value: number, fractionDigits = 8): string {
  if (!Number.isFinite(value)) {
    throw new Error("Cannot format non-finite decimal");
  }
  const fixed = value.toFixed(fractionDigits);
  return fixed.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}
