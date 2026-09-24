export interface ExtendedConfig {
 apiBaseUrl: string;
 apiKey?: string;
 starkPrivateKey?: string;
 vaultId?: string;
 tradingEnabled: boolean;
 userAgent: string;
 /** GTT signature lifetime in hours for placed orders (resting limit
  * entries and TP/SL triggers). Optional: the adapter falls back to a
  * 7-day default when unset. */
 orderExpirationHours?: number;
}
