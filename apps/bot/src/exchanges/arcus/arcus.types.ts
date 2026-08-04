export interface ArcusConfig {
  apiBaseUrl: string;
  apiKey?: string;
  accountAddress?: string;
  tradingEnabled: boolean;
  userAgent: string;
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
