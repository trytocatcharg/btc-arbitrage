export interface ArcusConfig {
  apiBaseUrl: string;
  apiKey?: string;
  /** Ed25519 signing seed, 64 hex chars (32 bytes). Required when
   * tradingEnabled — the API key alone cannot sign orders. Secret: never
   * log. */
  privateKey?: string;
  accountAddress?: string;
  tradingEnabled: boolean;
  userAgent: string;
  /** Routing fee inputs in basis points. OPTIONAL explicit operator
   * overrides: when undefined, main.ts resolves the base tier (level 0 —
   * the most expensive, conservative tier) from the public live
   * GET /v1/feetiers table at startup. */
  makerFeeBps?: number;
  takerFeeBps?: number;
  /** goodTilTime lifetime for placed orders in days (default 90; Arcus
   * requires at least 1 month in the future, validated 31..2160). */
  orderExpirationDays: number;
}

export interface ArcusMarketInfo {
  marketDisplayName?: string;
  marketId?: number | string;
  status?: string;
  baseAsset?: string;
  quoteAsset?: string;
  type?: string;
  category?: string;
  oraclePrice?: string;
  markPrice?: string;
  lastTradePrice?: string;
  [key: string]: unknown;
}

export interface ArcusMarketsResponse {
  markets?: ArcusMarketInfo[];
}

export interface ArcusPriceEntry {
  marketDisplayName?: string;
  oraclePrice?: string;
  markPrice?: string;
  sequencer?: number;
  [key: string]: unknown;
}

export type ArcusPricesResponse = Record<string, ArcusPriceEntry>;

export interface ArcusBboLevel {
  price?: string;
  size?: string;
}

export interface ArcusBboResponse {
  bestBid?: ArcusBboLevel | null;
  bestAsk?: ArcusBboLevel | null;
  lastSequenceId?: number;
  globalSequenceId?: number;
  timestamp?: number;
}
