// Types for the Variational exchange integration.
// Mirrors docs/exchanges/variational.md. Numeric strings stay `string`.

/** Mirror of `BotConfig.variational` from packages/config. */
export interface VariationalConfig {
 apiBaseUrl: string;
 priceApiBaseUrl: string;
 accountAddress?: string;
 accountPrivateKey?: string;
 referralCode?: string;
 tradingEnabled: boolean;
 userAgent: string;
 priceCacheTtlMs: number;
}

/**
 * Variational identifies instruments by object, not symbol string.
 * Example: { underlying: 'BTC', instrument_type: 'perpetual_future',
 *            settlement_asset: 'USDC', funding_interval_s: 3600 }
 */
export interface VariationalInstrument {
 underlying: string;
 instrument_type: "perpetual_future";
 settlement_asset: "USDC";
 funding_interval_s: number;
}

/** Public price stats payload from GET {PRICE_API}/metadata/stats. */
export interface VariationalStatsListing {
 /** Underlying asset symbol, e.g. 'BTC'. */
 instrument?: unknown;
 mark_price?: string;
 quotes?: {
  size_1k?: { bid?: string; ask?: string };
  size_100k?: { bid?: string; ask?: string };
 };
 base_spread_bps?: string;
 /** Per-ticker quantity limits. */
 bid_limits?: { min_qty?: string; min_qty_tick?: string; max_qty?: string };
 ask_limits?: { min_qty?: string; min_qty_tick?: string; max_qty?: string };
 [key: string]: unknown;
}

export interface VariationalStatsPayload {
 listings?: VariationalStatsListing[];
 [key: string]: unknown;
}

/** Response of POST /quotes/indicative (may be list-wrapped; unwrap first). */
export interface VariationalQuoteRecord {
 quote_id?: string;
 bid?: string;
 ask?: string;
 mark_price?: string;
 [key: string]: unknown;
}

/** Response of POST /quotes/accept (may be list-wrapped; unwrap first). */
export interface VariationalOrderRecord {
 rfq_id?: string;
 order_id?: string;
 status?: string;
 side?: string;
 qty?: string;
 limit_price?: string;
 trigger_price?: string;
 order_type?: string;
 is_reduce_only?: boolean;
 instrument?: VariationalInstrument;
 [key: string]: unknown;
}

/** Element of GET /positions. */
export interface VariationalPositionRecord {
 instrument?: VariationalInstrument;
 qty?: string;
 entry_price?: string;
 mark_price?: string;
 upnl?: string;
 side?: string;
 [key: string]: unknown;
}

/** Response of GET /account/balance. */
export interface VariationalBalanceRecord {
 available?: string;
 balance?: string;
 total?: string;
 equity?: string;
 upnl?: string;
 [key: string]: unknown;
}

/** SIWE login session. */
export interface VariationalSession {
 jwt: string;
 address: string;
 issuedAt: number;
}
