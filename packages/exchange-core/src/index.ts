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
}

export function normalizeSymbol(symbol: string): string {
  return symbol.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}
