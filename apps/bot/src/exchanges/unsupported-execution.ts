import type { ExecutionAdapter, ExecutionOrder, ExecutionOrderRequest, ExchangePosition, MarketMetadata, PriceRequest } from '@btc-arbitrage/exchange-core';

/** Safe default until each venue has a reviewed signed-order implementation. */
export function createUnsupportedExecutionAdapter(exchangeName: string): ExecutionAdapter {
  const blocked = (): never => { throw new Error(`${exchangeName} live execution is intentionally blocked: signed order, fill, position and protection endpoints are not verified.`); };
  return {
    getBestBidOffer: async (_: PriceRequest) => blocked(),
    getMarketMetadata: async (_: PriceRequest): Promise<MarketMetadata> => blocked(),
    getAvailableMarginUsd: async () => blocked(),
    validateExecutionPreflight: async () => blocked(),
    submitExecutionOrder: async (_: ExecutionOrderRequest): Promise<ExecutionOrder> => blocked(),
    getExecutionOrder: async (_: string): Promise<ExecutionOrder> => blocked(),
    cancelExecutionOrder: async (_: string) => blocked(),
    getPosition: async (_: { symbol: string; side: 'long' | 'short' }): Promise<ExchangePosition | null> => blocked()
  };
}
