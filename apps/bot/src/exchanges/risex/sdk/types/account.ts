export interface Balance {
  balance: string;
  [key: string]: unknown;
}

export interface Position {
  market_id: string;
  size?: string;
  quantity?: string;
  side?: number;
  entry_price?: string;
  mark_price?: string;
  unrealized_pnl?: string;
  liquidation_price?: string;
  leverage?: string;
  margin_mode?: number;
  [key: string]: unknown;
}
