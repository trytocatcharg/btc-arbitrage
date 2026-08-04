export type ExchangeId = 'risex' | 'extended' | 'arcus';
export type MarketType = 'perpetual' | 'futures';
export type PriceSource = 'mark' | 'index' | 'last';
export type OrderSide = 'long' | 'short';
export type ExecutionMode = 'dry-run' | 'live';
export type SignalStatus = 'created' | 'notified' | 'failed' | 'ignored';
export type OperationStatus = 'dry_run' | 'blocked' | 'submitted' | 'failed';
export type EventLevel = 'debug' | 'info' | 'warn' | 'error';

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
  direction: 'a_above_b' | 'b_above_a' | 'flat';
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
  legs?: Array<{ exchangeId: ExchangeId; side: OrderSide; plannedPriceUsd?: string }>;
  createdAt: Date;
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

export interface CalculateSpreadInput {
  exchangeA: PriceSnapshot;
  exchangeB: PriceSnapshot;
  thresholdUsd: string;
  calculatedAt?: Date;
}

export function calculateSpread(input: CalculateSpreadInput): SpreadSnapshot {
  const a = parseDecimal(input.exchangeA.priceUsd, 'exchangeA.priceUsd');
  const b = parseDecimal(input.exchangeB.priceUsd, 'exchangeB.priceUsd');
  const threshold = parseDecimal(input.thresholdUsd, 'thresholdUsd');
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
    direction: diff > 0 ? 'a_above_b' : diff < 0 ? 'b_above_a' : 'flat',
    thresholdUsd: formatDecimal(threshold),
    thresholdMatched: absoluteDiff >= threshold,
    calculatedAt: input.calculatedAt ?? new Date()
  };
}

export function parseDecimal(value: string, fieldName = 'decimal'): number {
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
    throw new Error('Cannot format non-finite decimal');
  }
  const fixed = value.toFixed(fractionDigits);
  return fixed.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}
