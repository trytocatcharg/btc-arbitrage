import type { ExchangeBalance } from '@btc-arbitrage/domain';

const COLLATERAL_ASSET = 'USDC';

export function normalizeRisexBalance(payload: unknown, receivedAt: Date = new Date()): ExchangeBalance {
  const body = unwrapData(payload);
  const totalEquityUsd = primitiveDecimal(body) ?? findDecimalAtPaths(body, [
    ['account', 'cross_margin_balance'],
    ['account', 'crossMarginBalance'],
    ['account', 'total_equity'],
    ['account', 'totalEquity'],
    ['cross_margin_balance'],
    ['crossMarginBalance'],
    ['total_equity'],
    ['totalEquity'],
    ['equity'],
    ['balance']
  ]) ?? findDecimalValue(body, [
    'equity',
    'total_equity',
    'totalEquity',
    'nav',
    'balance',
    'cross_margin_balance',
    'crossMarginBalance',
    'margin_balance',
    'marginBalance',
    'available_balance',
    'availableBalance'
  ]);

  if (!totalEquityUsd) {
    throw new Error('Could not normalize RISEx balance payload');
  }

  return {
    exchangeId: 'risex',
    displayName: 'RISEx',
    asset: COLLATERAL_ASSET,
    status: 'available',
    totalEquityUsd,
    availableUsd: findDecimalAtPaths(body, [['account', 'available_balance'], ['account', 'availableBalance'], ['available_balance'], ['availableBalance']]) ?? findDecimalValue(body, ['available_balance', 'availableBalance', 'available_margin', 'availableMargin', 'free_collateral', 'freeCollateral']) ?? totalEquityUsd,
    marginUsedUsd: findDecimalAtPaths(body, [['account', 'initial_margin'], ['account', 'initialMargin'], ['initial_margin'], ['initialMargin']]) ?? findDecimalValue(body, ['initial_margin', 'initialMargin', 'margin_used', 'marginUsed', 'used_margin', 'usedMargin']) ?? null,
    unrealizedPnlUsd: findDecimalAtPaths(body, [['account', 'unrealized_pnl'], ['account', 'unrealised_pnl'], ['account', 'unrealizedPnl'], ['account', 'unrealisedPnl'], ['unrealized_pnl'], ['unrealised_pnl'], ['unrealizedPnl'], ['unrealisedPnl']]) ?? findDecimalValue(body, ['unrealized_pnl', 'unrealised_pnl', 'unrealizedPnl', 'unrealisedPnl']) ?? null,
    source: '/v1/account/cross-margin-balance',
    receivedAt: receivedAt.toISOString()
  };
}

export function normalizeExtendedBalance(payload: unknown, receivedAt: Date = new Date()): ExchangeBalance {
  const body = unwrapData(payload);
  const syntheticZeroBalance = isRecord(body) && body.syntheticZeroBalance === true;

  if (syntheticZeroBalance) {
    return {
      exchangeId: 'extended',
      displayName: 'Extended',
      asset: COLLATERAL_ASSET,
      status: 'available',
      totalEquityUsd: '0',
      availableUsd: '0',
      marginUsedUsd: '0',
      unrealizedPnlUsd: '0',
      source: '/api/v1/user/balance',
      syntheticZeroBalance: true,
      message: 'Extended returned 404 for balance; normalized as zero balance.',
      receivedAt: receivedAt.toISOString()
    };
  }

  const totalEquityUsd = findDecimalAtPaths(body, [['equity'], ['balance']]) ?? findDecimalValue(body, ['equity', 'balance']);
  if (!totalEquityUsd) {
    throw new Error('Could not normalize Extended balance payload');
  }

  return {
    exchangeId: 'extended',
    displayName: 'Extended',
    asset: COLLATERAL_ASSET,
    status: 'available',
    totalEquityUsd,
    availableUsd: findDecimalAtPaths(body, [['availableForTrade'], ['availableForTrading'], ['availableForWithdrawal']]) ?? findDecimalValue(body, ['availableForTrade', 'availableForTrading', 'availableForWithdrawal']) ?? null,
    marginUsedUsd: findDecimalAtPaths(body, [['initialMargin']]) ?? findDecimalValue(body, ['initialMargin']) ?? null,
    unrealizedPnlUsd: findDecimalAtPaths(body, [['unrealisedPnl'], ['unrealizedPnl']]) ?? findDecimalValue(body, ['unrealisedPnl', 'unrealizedPnl']) ?? null,
    source: '/api/v1/user/balance',
    receivedAt: receivedAt.toISOString()
  };
}

export function createUnconfiguredBalance(input: { exchangeId: 'risex' | 'extended'; displayName: string; message: string; receivedAt?: Date }): ExchangeBalance {
  return createEmptyBalance({ ...input, status: 'unconfigured' });
}

export function createErrorBalance(input: { exchangeId: 'risex' | 'extended'; displayName: string; message: string; receivedAt?: Date }): ExchangeBalance {
  return createEmptyBalance({ ...input, status: 'error' });
}

function createEmptyBalance(input: { exchangeId: 'risex' | 'extended'; displayName: string; status: 'unconfigured' | 'error'; message: string; receivedAt?: Date }): ExchangeBalance {
  return {
    exchangeId: input.exchangeId,
    displayName: input.displayName,
    asset: COLLATERAL_ASSET,
    status: input.status,
    totalEquityUsd: null,
    availableUsd: null,
    marginUsedUsd: null,
    unrealizedPnlUsd: null,
    source: input.exchangeId === 'risex' ? '/v1/account/cross-margin-balance' : '/api/v1/user/balance',
    message: input.message,
    receivedAt: (input.receivedAt ?? new Date()).toISOString()
  };
}

function unwrapData(payload: unknown): unknown {
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!isRecord(current) || !('data' in current)) return current;
    current = current.data;
  }
  return current;
}

function primitiveDecimal(value: unknown): string | undefined {
  if (typeof value === 'string' && isDecimalString(value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function findDecimalAtPaths(value: unknown, paths: string[][]): string | undefined {
  for (const path of paths) {
    const candidate = primitiveDecimal(getPath(value, path));
    if (candidate) return candidate;
  }

  return undefined;
}

function findDecimalValue(value: unknown, keys: string[], depth = 0): string | undefined {
  if (depth > 4) return undefined;

  if (Array.isArray(value)) {
    for (const entry of value) {
      const candidate = findDecimalValue(entry, keys, depth + 1);
      if (candidate) return candidate;
    }

    return undefined;
  }

  if (!isRecord(value)) return undefined;

  for (const key of keys) {
    const candidate = primitiveDecimal(value[key]);
    if (candidate) return candidate;
  }

  for (const entry of Object.values(value)) {
    const candidate = findDecimalValue(entry, keys, depth + 1);
    if (candidate) return candidate;
  }

  return undefined;
}

function getPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }

  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isDecimalString(value: string): boolean {
  return /^[-+]?\d+(\.\d+)?$/.test(value.trim());
}
