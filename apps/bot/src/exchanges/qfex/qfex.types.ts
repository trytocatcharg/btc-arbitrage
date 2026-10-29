/** QFEX adapter configuration (BotConfig.qfex; docs/exchanges/qfex.md).
 * `apiKey` is the QFEX PUBLIC key (`qfex_pub_…`) and `secretKey` the HMAC
 * secret — both are secrets for logging purposes and are never logged. */
export interface QfexConfig {
  apiBaseUrl: string;
  wsBaseUrl: string;
  apiKey?: string;
  secretKey?: string;
  /** Optional subaccount UUID; sent as x-qfex-requested-account-id on
   * private REST calls and as account_id in the WS auth message. Omit to
   * use the primary account. */
  accountId?: string;
  tradingEnabled: boolean;
  userAgent: string;
}

/** GET /md/contracts item. Prices are decimal STRINGS; there is no mark
 * price in the REST surface (index/last only). */
export interface QfexContract {
  ticker_id: string;
  base_currency: string;
  target_currency: string;
  last_price: string;
  index_price: string;
  base_volume: string;
  target_volume: string;
  funding_rate: string;
  product_type: string;
}

/** GET /refdata item. Sizes are decimal strings; leverage is an integer. */
export interface QfexRefdataSymbol {
  symbol: string;
  base_asset: string;
  quote_asset: string;
  tick_size: string;
  lot_size: string;
  min_quantity: string;
  max_quantity: string;
  default_max_leverage: number;
  order_types: string[] | null;
  order_time_in_force: string[] | null;
  status: string;
  product_category: string;
}

/** GET /md/orderbook/{ticker_id}. Bids/asks are [price, size] string
 * tuples; the schema allows null entries — guards must skip them. */
export interface QfexOrderBook {
  ticker_id: string;
  timestamp: number;
  bids: Array<[string, string] | null> | null;
  asks: Array<[string, string] | null> | null;
}

/** GET /user/positions payload. All quantities are JSON NUMBERS; `position`
 * is signed (positive = long, negative = short). */
export interface QfexPosition {
  symbol: string;
  position: number;
  average_price: number;
  leverage: number;
  margin_mode?: string;
  realised_pnl: number;
  unrealised_pnl: number;
}

export interface QfexBalance {
  available_balance: number;
  deposit: number;
  order_margin: number;
  position_margin: number;
  unrealised_pnl: number;
  net_funding: number;
}

export interface QfexPositionsResponse {
  positions: QfexPosition[] | null;
  balance: QfexBalance;
}

/** GET /user/subaccounts/balance item + envelope (live shape verified
 * 2026-11-05). `available_balance` is the account's usable margin; the
 * master account is the primary one. Works on fresh accounts, unlike
 * /user/positions which 500s without position history. */
export interface QfexAccountBalance {
  account_id: string;
  equity: number;
  available_balance: number;
  is_master: boolean;
}

export interface QfexSubaccountBalancesResponse {
  accounts: QfexAccountBalance[];
}

/** GET /user/trade item. All quantities are JSON NUMBERS;
 * `order_timestamp` is unix seconds (fractional). `liquidation` is an
 * opaque string in the schema (no enum documented) — the adapter only
 * treats clearly truthy values as liquidations (see qfex.md). */
export interface QfexTrade {
  id: string;
  symbol: string;
  price: number;
  quantity: number;
  side: string;
  fee: number;
  order_id: string;
  order_type: string;
  tif: string;
  order_timestamp: number;
  realised_pnl_change: number;
  liquidation: string;
  order_origin: string;
}

export interface QfexTradesResponse {
  data: QfexTrade[] | null;
  count: number;
}

// ---- Trade WebSocket frames (wss://trade.qfex.com) ----

/** `order_response` frame payload. Quantities/prices are JSON numbers;
 * `update_time` is unix seconds (fractional). */
export interface QfexOrderResponse {
  order_id: string;
  symbol: string;
  status: string;
  quantity: number;
  price: number;
  side?: string;
  type?: string;
  time_in_force?: string;
  client_order_id?: string;
  quantity_remaining?: number;
  update_time?: number;
  trade_id?: string | null;
}

/** `stop_order_response` frame payload (TP/SL orders may answer with this
 * instead of order_response — live-verify, see qfex.md). */
export interface QfexStopOrderResponse {
  stop_order_id: string;
  symbol: string;
  price: number;
  quantity: number;
  direction?: string;
  stop_order_type?: string;
  client_order_id?: string;
  update_time?: string;
}

/** `err` frame payload. `incoming_message` echoes the offending command. */
export interface QfexErrorFrame {
  error_code: string;
  message?: string | null;
  incoming_message?: unknown;
}
