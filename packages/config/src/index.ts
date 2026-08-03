import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ExchangeId, ExecutionMode, MarketType, PriceSource } from '@btc-arbitrage/domain';

export interface BotConfig {
  databaseUrl?: string;
  exchangeA: ExchangeId;
  exchangeB: ExchangeId;
  exchangeLong?: ExchangeId;
  exchangeShort?: ExchangeId;
  btcSymbol: string;
  marketType: MarketType;
  priceSource: PriceSource;
  pricePollIntervalMs: number;
  minPriceDiffUsd: string;
  leverage: number;
  maxLeverage: number;
  botExecutionMode: ExecutionMode;
  botRunOnce: boolean;
  enableOrderPlacement: boolean;
  confirmLiveTrading?: string;
  risex: {
    apiBaseUrl: string;
    accountAddress?: string;
    tradingEnabled: boolean;
  };
  extended: {
    apiBaseUrl: string;
    apiKey?: string;
    tradingEnabled: boolean;
    userAgent: string;
  };
  telegram: {
    enabled: boolean;
    botToken?: string;
    chatId?: string;
    alertCooldownMs: number;
  };
  readApi: {
    enabled: boolean;
    host: string;
    port: number;
  };
  webApiBaseUrl: string;
  logLevel: string;
}

export function loadBotConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const exchangeA = parseExchange(env.EXCHANGE_A ?? 'risex', 'EXCHANGE_A');
  const exchangeB = parseExchange(env.EXCHANGE_B ?? 'extended', 'EXCHANGE_B');
  if (exchangeA === exchangeB) throw new Error('EXCHANGE_A and EXCHANGE_B must be different');

  const priceSource = parsePriceSource(env.PRICE_SOURCE ?? 'mark');
  const marketType = parseMarketType(env.MARKET_TYPE ?? 'perpetual');
  const minPriceDiffUsd = parsePositiveDecimalString(env.MIN_PRICE_DIFF_USD ?? '40', 'MIN_PRICE_DIFF_USD');
  const maxLeverage = parsePositiveInteger(env.MAX_LEVERAGE ?? '3', 'MAX_LEVERAGE');
  const leverage = parsePositiveInteger(env.LEVERAGE ?? '3', 'LEVERAGE');
  if (leverage > maxLeverage) throw new Error('LEVERAGE must be <= MAX_LEVERAGE');

  const executionMode = parseExecutionMode(env.BOT_EXECUTION_MODE ?? 'dry-run');
  const botRunOnce = parseBoolean(env.BOT_RUN_ONCE ?? 'false');
  const enableOrderPlacement = parseBoolean(env.ENABLE_ORDER_PLACEMENT ?? 'false');
  const risexTradingEnabled = parseBoolean(env.RISEX_TRADING_ENABLED ?? 'false');
  const extendedTradingEnabled = parseBoolean(env.EXTENDED_TRADING_ENABLED ?? 'false');
  if (executionMode === 'live' || enableOrderPlacement) {
    throw new Error('Live order placement is not implemented in this slice; keep BOT_EXECUTION_MODE=dry-run and ENABLE_ORDER_PLACEMENT=false');
  }
  const telegramEnabled = parseBoolean(env.TELEGRAM_ENABLED ?? 'false');
  const telegramAlertCooldownMs = parseNonNegativeInteger(env.TELEGRAM_ALERT_COOLDOWN_MS ?? '60000', 'TELEGRAM_ALERT_COOLDOWN_MS');

  if (telegramEnabled && (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID)) {
    throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required when TELEGRAM_ENABLED=true');
  }

  return {
    databaseUrl: emptyToUndefined(env.DATABASE_URL),
    exchangeA,
    exchangeB,
    exchangeLong: env.EXCHANGE_LONG ? parseExchange(env.EXCHANGE_LONG, 'EXCHANGE_LONG') : undefined,
    exchangeShort: env.EXCHANGE_SHORT ? parseExchange(env.EXCHANGE_SHORT, 'EXCHANGE_SHORT') : undefined,
    btcSymbol: env.BTC_SYMBOL ?? 'BTCUSDT',
    marketType,
    priceSource,
    pricePollIntervalMs: parsePositiveInteger(env.PRICE_POLL_INTERVAL_MS ?? '1000', 'PRICE_POLL_INTERVAL_MS'),
    minPriceDiffUsd,
    leverage,
    maxLeverage,
    botExecutionMode: executionMode,
    botRunOnce,
    enableOrderPlacement,
    confirmLiveTrading: emptyToUndefined(env.CONFIRM_LIVE_TRADING),
    risex: {
      apiBaseUrl: trimTrailingSlash(env.RISEX_API_BASE_URL ?? 'https://api.rise.trade'),
      accountAddress: emptyToUndefined(env.RISEX_ACCOUNT_ADDRESS),
      tradingEnabled: risexTradingEnabled
    },
    extended: {
      apiBaseUrl: trimTrailingSlash(env.EXTENDED_API_BASE_URL ?? 'https://api.starknet.extended.exchange'),
      apiKey: emptyToUndefined(env.EXTENDED_API_KEY),
      tradingEnabled: extendedTradingEnabled,
      userAgent: env.EXTENDED_USER_AGENT ?? 'btc-arbitrage-bot/0.1'
    },
    telegram: {
      enabled: telegramEnabled,
      botToken: emptyToUndefined(env.TELEGRAM_BOT_TOKEN),
      chatId: emptyToUndefined(env.TELEGRAM_CHAT_ID),
      alertCooldownMs: telegramAlertCooldownMs
    },
    readApi: {
      enabled: parseBoolean(env.READ_API_ENABLED ?? 'true'),
      host: env.READ_API_HOST ?? '127.0.0.1',
      port: parsePositiveInteger(env.READ_API_PORT ?? '3001', 'READ_API_PORT')
    },
    webApiBaseUrl: env.WEB_API_BASE_URL ?? 'http://127.0.0.1:3001',
    logLevel: env.LOG_LEVEL ?? 'info'
  };
}

export function redactSecrets(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = /token|key|secret|private|signature|authorization|databaseUrl|DATABASE_URL/i.test(key) ? '[REDACTED]' : redactSecrets(entry);
    }
    return out;
  }
  return value;
}

function redactString(value: string): string {
  return value.replace(/(mysql:\/\/[^:]+:)[^@]+(@)/, '$1[REDACTED]$2');
}

function parseExchange(value: string, field: string): ExchangeId {
  if (value === 'risex' || value === 'extended') return value;
  throw new Error(`${field} must be one of: risex, extended`);
}

function parsePriceSource(value: string): PriceSource {
  if (value === 'mark' || value === 'index' || value === 'last') return value;
  throw new Error('PRICE_SOURCE must be one of: mark, index, last');
}

function parseMarketType(value: string): MarketType {
  if (value === 'perpetual' || value === 'futures') return value;
  throw new Error('MARKET_TYPE must be one of: perpetual, futures');
}

function parseExecutionMode(value: string): ExecutionMode {
  if (value === 'dry-run' || value === 'live') return value;
  throw new Error('BOT_EXECUTION_MODE must be dry-run or live');
}

function parseBoolean(value: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Expected boolean string true/false, got ${value}`);
}

function parsePositiveInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${field} must be a positive integer`);
  return parsed;
}

function parseNonNegativeInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${field} must be a non-negative integer`);
  return parsed;
}

function parsePositiveDecimalString(value: string, field: string): string {
  if (!/^\d+(\.\d+)?$/.test(value) || Number(value) <= 0) throw new Error(`${field} must be a positive decimal`);
  return value;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/$/, '');
}


export interface LoadDotEnvFileOptions {
  cwd?: string;
  fileName?: string;
}

export function loadDotEnvFile(options: LoadDotEnvFileOptions = {}): string | undefined {
  const fileName = options.fileName ?? '.env';
  const start = resolve(options.cwd ?? process.cwd());
  const envPath = findUp(start, fileName);
  if (!envPath) return undefined;

  const loadEnvFile = (process as typeof process & { loadEnvFile?: (path: string) => void }).loadEnvFile;
  if (typeof loadEnvFile === 'function') {
    loadEnvFile(envPath);
    return envPath;
  }

  loadDotEnvFallback(envPath);
  return envPath;
}

function findUp(start: string, fileName: string): string | undefined {
  let current = start;
  while (true) {
    const candidate = join(current, fileName);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function loadDotEnvFallback(envPath: string): void {
  const content = readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = stripEnvQuotes(rawValue);
  }
}

function stripEnvQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
