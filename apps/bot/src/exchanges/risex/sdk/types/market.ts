export interface MarketConfig {
  min_order_size: string;
  step_size: string;
  step_price: string;
  max_leverage: string;
  [key: string]: unknown;
}

export interface Market {
  market_id: string;
  display_name?: string;
  base_asset_symbol?: string;
  quote_asset_symbol?: string;
  symbol?: string;
  type?: string;
  last_price?: string;
  mark_price?: string;
  index_price?: string;
  visible?: boolean;
  post_only?: boolean;
  config: MarketConfig;
  [key: string]: unknown;
}
