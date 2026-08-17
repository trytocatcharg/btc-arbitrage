import type { Side, OrderType, TimeInForce, StpMode, StopPriceOption } from './common.js';
import type { NonceState } from './auth.js';

export interface OrderParams {
  market_id: number;
  side: Side;
  order_type: OrderType;
  price_ticks: number;
  size_steps: number;
  time_in_force: TimeInForce;
  post_only: boolean;
  reduce_only: boolean;
  stp_mode: StpMode;
  ttl_units: number;
  client_order_id?: string;
  builder_id?: number;
  nonce?: NonceState;
}

export interface CancelParams {
  market_id: number;
  order_id: string;
  resting_order_id?: string | number;
  nonce?: NonceState;
}

export interface TpSlParams {
  market_id: number;
  side: Side;
  size: string;
  stop_price: string;
  limit_price: string;
  stop_price_option?: StopPriceOption;
  tif?: TimeInForce;
}

export interface OrderResponse {
  order_id: string;
  sc_order_id?: string;
  tx_hash?: string;
  status?: string;
  filled_size_steps?: string | number;
  [key: string]: unknown;
}

export interface CancelResponse {
  success: boolean;
  tx_hash?: string;
  [key: string]: unknown;
}

export interface CancelAllResponse {
  success: boolean;
  tx_hash?: string;
  block_number?: string;
  [key: string]: unknown;
}

export interface OpenOrder {
  order_id: string;
  wide_order_id?: string;
  resting_order_id?: string;
  account?: string;
  market_id: number;
  side?: number;
  order_type?: number;
  price_ticks?: number;
  size_steps?: number;
  time_in_force?: number;
  post_only?: boolean;
  reduce_only?: boolean;
  status?: string;
  filled_size_steps?: string | number;
  average_fill_price?: string;
  [key: string]: unknown;
}

export interface OrderHistoryEntry {
  order_id: string;
  wide_order_id?: string;
  resting_order_id?: string;
  market_id: string;
  side: number;
  size: string;
  price: string;
  filled_size?: string;
  order_type: number;
  status: string;
  timestamp: string;
  [key: string]: unknown;
}

export interface Fill {
  fill_id?: string;
  order_id: string;
  market_id: string;
  side: number;
  size: string;
  price: string;
  fee?: string;
  timestamp: string;
  [key: string]: unknown;
}

export interface TpslOrder {
  order_id: string;
  stop_type?: string;
  status?: string;
  side?: number;
  size?: string;
  stop_price?: string;
  limit_price?: string;
  [key: string]: unknown;
}
