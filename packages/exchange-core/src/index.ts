import type { ExchangeId, MarketType, Operation, PriceSnapshot, PriceSource } from '@btc-arbitrage/domain';

export interface ExchangeMarket {
  exchangeId: ExchangeId;
  normalizedSymbol: string;
  externalMarketId: string;
  marketType: MarketType;
  supportsPriceSources: PriceSource[];
  raw?: unknown;
}

export interface PriceRequest {
  symbol: string;
  marketType: MarketType;
  priceSource: PriceSource;
}

export interface PriceSubscriptionRequest extends PriceRequest {
  intervalMs?: number;
}

export interface CreateOrderRequest {
  signalId?: string;
  symbol: string;
  exchangePayload?: Record<string, unknown>;
}

/** Execution primitives deliberately stay adapter-owned: an adapter must not claim
 * support until its exchange-specific signing and request schema are verified. */
export interface BestBidOffer { bidUsd: string; askUsd: string; receivedAt: Date; }
export interface MarketMetadata { minQuantityBase: string; quantityStepBase: string; maxLeverage?: number; positionMode?: 'one-way' | 'hedge'; }
export interface ExecutionOrderRequest { clientOrderId: string; symbol: string; side: 'buy' | 'sell'; type: 'limit' | 'market' | 'take-profit-market' | 'stop-market'; quantityBase: string; priceUsd?: string; reduceOnly?: boolean; triggerPriceUsd?: string; }
export interface ExecutionOrder { id: string; status: 'new' | 'partially_filled' | 'filled' | 'cancelled' | 'rejected'; filledQuantityBase: string; averageFillPriceUsd?: string; }
export interface ExchangePosition { id?: string; side: 'long' | 'short'; quantityBase: string; entryPriceUsd?: string; status: 'open' | 'closed'; closeReason?: 'tp' | 'sl' | 'manual' | 'liquidation' | 'unknown'; exitPriceUsd?: string; realizedPnlUsd?: string; }
export interface ExecutionAdapter {
  getBestBidOffer(input: PriceRequest): Promise<BestBidOffer>;
  getMarketMetadata(input: PriceRequest): Promise<MarketMetadata>;
  getAvailableMarginUsd(): Promise<string>;
  validateExecutionPreflight(input: { symbol: string; leverage: number }): Promise<void>;
  submitExecutionOrder(input: ExecutionOrderRequest): Promise<ExecutionOrder>;
  getExecutionOrder(orderId: string): Promise<ExecutionOrder>;
  cancelExecutionOrder(orderId: string): Promise<void>;
  getPosition(input: { symbol: string; side: 'long' | 'short' }): Promise<ExchangePosition | null>;
}

export interface CancelOrderRequest {
  orderId?: string;
  externalId?: string;
  exchangePayload?: Record<string, unknown>;
}

export interface OrderPlaceholder extends Operation {
  externalOrderId?: string;
  exchangeResponse?: unknown;
}

export interface ExchangeAdapter {
  readonly id: ExchangeId;
  readonly displayName: string;
  readonly capabilities: {
    nativeFetch: true;
    websocket: 'native' | 'dependency' | 'polling-only';
    orderPlacement: boolean;
  };
  getMarkets(): Promise<ExchangeMarket[]>;
  getPriceSnapshot(input: PriceRequest): Promise<PriceSnapshot>;
  subscribePrices?(input: PriceSubscriptionRequest): AsyncIterable<PriceSnapshot>;
  createOrder?(input: CreateOrderRequest): Promise<OrderPlaceholder>;
  cancelOrder?(input: CancelOrderRequest): Promise<OrderPlaceholder>;
  execution?: ExecutionAdapter;
}

export function normalizeSymbol(symbol: string): string {
  return symbol.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}
