import type {
  ExchangeId,
  MarketType,
  Operation,
  PriceSnapshot,
  PriceSource,
} from "@btc-arbitrage/domain";

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

/** Public market statistics for a symbol. Every field is optional: a venue
 * that does not expose a value leaves it undefined — consumers must render
 * "n/d" (never estimate). */
export interface MarketStats {
  /** Traded volume over the last 24h in USD (decimal string). */
  volume24hUsd?: string;
}

export interface CreateOrderRequest {
  signalId?: string;
  symbol: string;
  exchangePayload?: Record<string, unknown>;
}

/** Execution primitives deliberately stay adapter-owned: an adapter must not claim
 * support until its exchange-specific signing and request schema are verified. */
export interface BestBidOffer {
  bidUsd: string;
  askUsd: string;
  receivedAt: Date;
}
export interface MarketMetadata {
  minQuantityBase: string;
  quantityStepBase: string;
  maxLeverage?: number;
  positionMode?:
    | "one-way"
    | "hedge" /** Price tick / minimum price increment of the venue (USD), e.g. "0.1". */;
  priceTickUsd?: string;
}
export interface ExecutionOrderRequest {
  clientOrderId: string;
  symbol: string;
  side: "buy" | "sell";
  type: "limit" | "market" | "take-profit-market" | "stop-market";
  quantityBase: string;
  priceUsd?: string;
  reduceOnly?: boolean;
  triggerPriceUsd?: string;
}
export interface ExecutionOrder {
  id: string;
  status: "new" | "partially_filled" | "filled" | "cancelled" | "rejected";
  filledQuantityBase: string;
  averageFillPriceUsd?: string;
  /** Real trading fee in USD (decimal string), summed over the fills this
   * record covers. Undefined when the venue payload does not expose it —
   * never estimated. */
  feeUsd?: string;
}
export interface ExchangePosition {
  id?: string;
  side: "long" | "short";
  quantityBase: string;
  entryPriceUsd?: string;
  status: "open" | "closed";
  closeReason?: "tp" | "sl" | "manual" | "liquidation" | "unknown";
  exitPriceUsd?: string;
  realizedPnlUsd?: string;
  /** Real trading fee in USD (decimal string) incurred by the position
   * records this snapshot covers. Undefined when the venue payload does
   * not expose it — never estimated. */
  feeUsd?: string;
}
export interface ExecutionAdapter {
  getBestBidOffer(input: PriceRequest): Promise<BestBidOffer>;
  getMarketMetadata(input: PriceRequest): Promise<MarketMetadata>;
  getAvailableMarginUsd(): Promise<string>;
  validateExecutionPreflight(input: {
    symbol: string;
    leverage: number;
  }): Promise<void>;
  submitExecutionOrder(input: ExecutionOrderRequest): Promise<ExecutionOrder>;
  getExecutionOrder(orderId: string): Promise<ExecutionOrder>;
  cancelExecutionOrder(orderId: string): Promise<void>;
  getPosition(input: {
    symbol: string;
    side: "long" | "short";
  }): Promise<ExchangePosition | null>;
  /** Best-effort recovery of exit data for a leg already detected closed
   * (e.g. a venue-side TP/SL trigger, where getPosition no longer reports
   * close price / realized PnL once the venue position record is gone).
   * Implementations resolve the closure from the protection order ids the
   * caller stored when the TP/SL orders were placed, keeping those ids as
   * the primary path, and may fall back to venue fill/order HISTORY when
   * the stored ids no longer resolve (an operator-moved trigger or a
   * manual close leaves only history behind). Returns null when the
   * closure cannot be resolved; must never throw. */
  resolveLegClosure?(input: {
    symbol: string;
    side: "long" | "short";
    tpOrderId?: string;
    slOrderId?: string;
    /** Leg quantity in base units (decimal string). When provided,
     * implementations that query fill history should match close fills
     * until the cumulative size reaches this quantity and price the exit
     * as a VWAP over those fills. */
    quantityBase?: string;
  }): Promise<{
    exitPriceUsd?: string;
    realizedPnlUsd?: string;
    exitOrderId?: string;
    closeReason?: "tp" | "sl" | "manual" | "liquidation";
    /** Real trading fee in USD (decimal string) summed over the exit fills
     * the closure was resolved from. Undefined when the venue payload does
     * not expose it — never estimated. */
    feeUsd?: string;
  } | null>;
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
    websocket: "native" | "dependency" | "polling-only";
    orderPlacement: boolean;
  };
  getMarkets(): Promise<ExchangeMarket[]>;
  getPriceSnapshot(input: PriceRequest): Promise<PriceSnapshot>;
  /** Optional 24h market stats (volume) used by the Telegram Pairs panel.
   * Implementations reuse their existing public markets payloads. */
  getMarketStats?(input: PriceRequest): Promise<MarketStats>;
  subscribePrices?(
    input: PriceSubscriptionRequest,
  ): AsyncIterable<PriceSnapshot>;
  createOrder?(input: CreateOrderRequest): Promise<OrderPlaceholder>;
  cancelOrder?(input: CancelOrderRequest): Promise<OrderPlaceholder>;
  execution?: ExecutionAdapter;
}

export function normalizeSymbol(symbol: string): string {
  return symbol.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}
