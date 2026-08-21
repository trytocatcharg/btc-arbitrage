import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ExecutionMode, type ExchangeId, type MarketType, type PriceSource } from '@btc-arbitrage/domain';

export interface DatabaseConfig {
  hostName: string;
  userName: string;
  port: number;
  userPassword: string;
  dbName: string;
  url: string;
}

export interface BotConfig {
  database: DatabaseConfig;
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
  botExecutionMode: ExecutionMode;
  botRunOnce: boolean;
  enableOrderPlacement: boolean;
  confirmLiveTrading?: string;
  openTrade: {
    notionalUsd: string;
    previewTtlMs: number;
    quoteMaxAgeMs: number;
    limitTimeoutMs: number;
    residualDeltaToleranceBase: string;
    takeProfitPercent: string;
    stopLossPercent: string;
    risexMakerFeeBps: string;
    risexTakerFeeBps: string;
    extendedMakerFeeBps: string;
    extendedTakerFeeBps: string;
  };
  risex: {
    apiBaseUrl: string;
    accountAddress?: string;
    accountPrivateKey?: string;
    sessionSignerPrivateKey?: string;
    tradingEnabled: boolean;
  };
  extended: {
    apiBaseUrl: string;
    apiKey?: string;
    starkPrivateKey?: string;
    vaultId?: string;
    tradingEnabled: boolean;
    userAgent: string;
  };
  arcus: {
    apiBaseUrl: string;
    apiKey?: string;
    accountAddress?: string;
    tradingEnabled: boolean;
    userAgent: string;
  };
  telegram: {
    enabled: boolean;
    botToken?: string;
    chatId?: string;
    alertCooldownMs: number;
  };
  logLevel: string;
}

export function loadBotConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const exchangeA = parseExchange(env.EXCHANGE_A ?? 'risex', 'EXCHANGE_A');
  const exchangeB = parseExchange(env.EXCHANGE_B ?? 'extended', 'EXCHANGE_B');
  if (exchangeA === exchangeB) throw new Error('EXCHANGE_A and EXCHANGE_B must be different');

  const priceSource = parsePriceSource(env.PRICE_SOURCE ?? 'mark');
  const marketType = parseMarketType(env.MARKET_TYPE ?? 'perpetual');
  const minPriceDiffUsd = parsePositiveDecimalString(env.MIN_PRICE_DIFF_USD ?? '40', 'MIN_PRICE_DIFF_USD');
  const leverage = parsePositiveInteger(env.LEVERAGE ?? '3', 'LEVERAGE');

  const executionMode = parseExecutionMode(env.BOT_EXECUTION_MODE ?? ExecutionMode.DryRun);
  const botRunOnce = parseBoolean(env.BOT_RUN_ONCE ?? 'false');
  const enableOrderPlacement = parseBoolean(env.ENABLE_ORDER_PLACEMENT ?? 'false');
  const risexTradingEnabled = parseBoolean(env.RISEX_TRADING_ENABLED ?? 'false');
  const extendedTradingEnabled = parseBoolean(env.EXTENDED_TRADING_ENABLED ?? 'false');
  const arcusTradingEnabled = parseBoolean(env.ARCUS_TRADING_ENABLED ?? 'false');
  if (executionMode === ExecutionMode.Live && !enableOrderPlacement) {
    throw new Error('ENABLE_ORDER_PLACEMENT must be true when BOT_EXECUTION_MODE=live');
  }
  if (enableOrderPlacement && executionMode !== ExecutionMode.Live) {
    throw new Error('BOT_EXECUTION_MODE must be live when ENABLE_ORDER_PLACEMENT=true');
  }
  const telegramEnabled = parseBoolean(env.TELEGRAM_ENABLED ?? 'false');
  const telegramAlertCooldownMs = parseNonNegativeInteger(env.TELEGRAM_ALERT_COOLDOWN_MS ?? '3600000', 'TELEGRAM_ALERT_COOLDOWN_MS');

  if (telegramEnabled && (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID)) {
    throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required when TELEGRAM_ENABLED=true');
  }

  const database = loadDatabaseConfig(env);
  const openTradeTakeProfitPercent = parsePositiveDecimalString(env.OPEN_TRADE_TAKE_PROFIT_PERCENT ?? '3', 'OPEN_TRADE_TAKE_PROFIT_PERCENT');
  const openTradeStopLossPercent = parsePositiveDecimalString(env.OPEN_TRADE_STOP_LOSS_PERCENT ?? '3', 'OPEN_TRADE_STOP_LOSS_PERCENT');
  if (Number(openTradeStopLossPercent) >= 100) {
    throw new Error('OPEN_TRADE_STOP_LOSS_PERCENT must be less than 100');
  }

  return {
    database,
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
    botExecutionMode: executionMode,
    botRunOnce,
    enableOrderPlacement,
    confirmLiveTrading: emptyToUndefined(env.CONFIRM_LIVE_TRADING),
    openTrade: {
      notionalUsd: parsePositiveDecimalString(env.OPEN_TRADE_NOTIONAL_USD ?? '100', 'OPEN_TRADE_NOTIONAL_USD'),
      previewTtlMs: parsePositiveInteger(env.OPEN_TRADE_PREVIEW_TTL_MS ?? '120000', 'OPEN_TRADE_PREVIEW_TTL_MS'),
      quoteMaxAgeMs: parsePositiveInteger(env.OPEN_TRADE_QUOTE_MAX_AGE_MS ?? '5000', 'OPEN_TRADE_QUOTE_MAX_AGE_MS'),
      limitTimeoutMs: parsePositiveInteger(env.OPEN_TRADE_LIMIT_TIMEOUT_MS ?? '30000', 'OPEN_TRADE_LIMIT_TIMEOUT_MS'),
      residualDeltaToleranceBase: parsePositiveDecimalString(env.OPEN_TRADE_RESIDUAL_DELTA_BTC ?? '0.00001', 'OPEN_TRADE_RESIDUAL_DELTA_BTC'),
      takeProfitPercent: openTradeTakeProfitPercent,
      stopLossPercent: openTradeStopLossPercent,
      risexMakerFeeBps: parseNonNegativeDecimalString(env.RISEX_MAKER_FEE_BPS ?? '1', 'RISEX_MAKER_FEE_BPS'),
      risexTakerFeeBps: parseNonNegativeDecimalString(env.RISEX_TAKER_FEE_BPS ?? '3', 'RISEX_TAKER_FEE_BPS'),
      extendedMakerFeeBps: parseNonNegativeDecimalString(env.EXTENDED_MAKER_FEE_BPS ?? '0', 'EXTENDED_MAKER_FEE_BPS'),
      extendedTakerFeeBps: parseNonNegativeDecimalString(env.EXTENDED_TAKER_FEE_BPS ?? '2.5', 'EXTENDED_TAKER_FEE_BPS')
    },
    risex: {
      apiBaseUrl: trimTrailingSlash(env.RISEX_API_BASE_URL ?? 'https://api.rise.trade'),
      accountAddress: emptyToUndefined(env.RISEX_ACCOUNT_ADDRESS),
      accountPrivateKey: emptyToUndefined(env.RISEX_ACCOUNT_PRIVATE_KEY),
      sessionSignerPrivateKey: emptyToUndefined(env.RISEX_SESSION_SIGNER_PRIVATE_KEY),
      tradingEnabled: risexTradingEnabled
    },
    extended: {
      apiBaseUrl: trimTrailingSlash(env.EXTENDED_API_BASE_URL ?? 'https://api.starknet.extended.exchange'),
      apiKey: emptyToUndefined(env.EXTENDED_API_KEY),
      starkPrivateKey: emptyToUndefined(env.EXTENDED_STARK_PRIVATE_KEY),
      vaultId: emptyToUndefined(env.EXTENDED_VAULT_ID),
      tradingEnabled: extendedTradingEnabled,
      userAgent: env.EXTENDED_USER_AGENT ?? 'btc-arbitrage-bot/0.1'
    },
    arcus: {
      apiBaseUrl: trimTrailingSlash(env.ARCUS_API_BASE_URL ?? 'https://api.arcus.xyz'),
      apiKey: emptyToUndefined(env.ARCUS_API_KEY),
      accountAddress: emptyToUndefined(env.ARCUS_ACCOUNT_ADDRESS),
      tradingEnabled: arcusTradingEnabled,
      userAgent: env.ARCUS_USER_AGENT ?? 'btc-arbitrage-bot/0.1'
    },
    telegram: {
      enabled: telegramEnabled,
      botToken: emptyToUndefined(env.TELEGRAM_BOT_TOKEN),
      chatId: emptyToUndefined(env.TELEGRAM_CHAT_ID),
      alertCooldownMs: telegramAlertCooldownMs
    },
    logLevel: env.LOG_LEVEL ?? 'info'
  };
}

export function redactSecrets(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = /token|key|secret|private|signature|authorization|password|databaseUrl|DATABASE_URL/i.test(key) ? '[REDACTED]' : redactSecrets(entry);
    }
    return out;
  }
  return value;
}


function loadDatabaseConfig(env: NodeJS.ProcessEnv): DatabaseConfig {
  const hostName = env.DATABASE_HOST_NAME ?? '127.0.0.1';
  const userName = env.DATABASE_USER_NAME ?? 'user';
  const port = parsePositiveInteger(env.DB_PORT ?? '3306', 'DB_PORT');
  const userPassword = env.DATABASE_USER_PASSWORD ?? 'password';
  const dbName = env.DATABASE_DB_NAME ?? 'btc_arbitrage';

  return {
    hostName,
    userName,
    port,
    userPassword,
    dbName,
    url: buildDatabaseUrl({ hostName, userName, port, userPassword, dbName })
  };
}

function buildDatabaseUrl(input: Omit<DatabaseConfig, 'url'>): string {
  const url = new URL('mysql://localhost');
  url.hostname = input.hostName;
  url.port = String(input.port);
  url.username = input.userName;
  url.password = input.userPassword;
  url.pathname = `/${input.dbName}`;
  return url.toString();
}

function redactString(value: string): string {
  return value.replace(/(mysql:\/\/[^:]+:)[^@]+(@)/, '$1[REDACTED]$2');
}

function parseExchange(value: string, field: string): ExchangeId {
  if (value === 'risex' || value === 'extended' || value === 'arcus') return value;
  throw new Error(`${field} must be one of: risex, extended, arcus`);
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
  if (value === ExecutionMode.DryRun || value === ExecutionMode.Live) return value;
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
function parseNonNegativeDecimalString(value: string, field: string): string {
  if (!/^\d+(\.\d+)?$/.test(value) || Number(value) < 0) throw new Error(`${field} must be a non-negative decimal`);
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
