export interface BackendConfig {
  host: string;
  port: number;
  corsAllowedOrigins: string[];
  risex: {
    apiBaseUrl: string;
    accountAddress?: string;
  };
  extended: {
    apiBaseUrl: string;
    apiKey?: string;
    userAgent: string;
  };
}

export function loadBackendConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  return {
    host: env.BACKEND_HOST ?? '127.0.0.1',
    port: parsePositiveInteger(env.BACKEND_PORT ?? '3002', 'BACKEND_PORT'),
    corsAllowedOrigins: parseCorsOrigins(env.BACKEND_CORS_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173'),
    risex: {
      apiBaseUrl: trimTrailingSlash(env.RISEX_API_BASE_URL ?? 'https://api.rise.trade'),
      accountAddress: emptyToUndefined(env.RISEX_ACCOUNT_ADDRESS)
    },
    extended: {
      apiBaseUrl: trimTrailingSlash(env.EXTENDED_API_BASE_URL ?? 'https://api.starknet.extended.exchange'),
      apiKey: emptyToUndefined(env.EXTENDED_API_KEY),
      userAgent: env.EXTENDED_USER_AGENT ?? 'btc-arbitrage-backend/0.1'
    }
  };
}

function parsePositiveInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${field} must be a positive integer`);
  return parsed;
}

function parseCorsOrigins(value: string): string[] {
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/$/, '');
}
