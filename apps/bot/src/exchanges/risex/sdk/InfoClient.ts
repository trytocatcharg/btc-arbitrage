import type { Position } from './types/account.js';
import type { SessionKeyStatus, SignerInfo, NonceState } from './types/auth.js';
import type { ClientOptions, Eip712Domain, SystemConfig } from './types/config.js';
import type { Market } from './types/market.js';
import type { Fill, OpenOrder, OrderHistoryEntry } from './types/order.js';
interface RisexSdkHttpClient {
  get(path: string, query?: Record<string, string | undefined>): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
}

export class InfoClient {
  public readonly http: RisexSdkHttpClient;

  constructor(opts?: ClientOptions, http?: RisexSdkHttpClient) {
    this.http = http ?? {
      get: async () => { throw new Error('A RISEx HTTP client must be provided for SDK usage in this codebase'); },
      post: async () => { throw new Error('A RISEx HTTP client must be provided for SDK usage in this codebase'); }
    };
  }

  async getSystemConfig(): Promise<SystemConfig> {
    return ensureRecord(unwrapData(await this.http.get('/v1/system/config'))) as unknown as SystemConfig;
  }

  async getEip712Domain(): Promise<Eip712Domain> {
    const raw = ensureRecord(unwrapData(await this.http.get('/v1/auth/eip712-domain')));
    return {
      name: requireString(raw, ['name']),
      version: requireString(raw, ['version']),
      chainId: BigInt(requireString(raw, ['chain_id', 'chainId'])),
      verifyingContract: requireString(raw, ['verifying_contract', 'verifyingContract'])
    };
  }

  async getNonceState(account: string): Promise<NonceState> {
    return ensureRecord(unwrapData(await this.http.get(`/v1/nonce-state/${account}`))) as unknown as NonceState;
  }

  async getMarkets(): Promise<Market[]> {
    const body = unwrapData(await this.http.get('/v1/markets'));
    if (Array.isArray(body)) return body.filter(isRecord) as Market[];
    if (isRecord(body) && Array.isArray(body.markets)) return body.markets.filter(isRecord) as Market[];
    return [];
  }

  async getPosition(marketId: number, account: string): Promise<Position | null> {
    const body = unwrapData(await this.http.get('/v1/account/position', { account, market_id: String(marketId) }));
    if (isRecord(body)) return body as unknown as Position;
    if (Array.isArray(body)) return (body.find(isRecord) as Position | undefined) ?? null;
    return null;
  }

  async getOpenOrders(account: string, marketId?: number): Promise<OpenOrder[]> {
    const body = unwrapData(await this.http.get('/v1/orders/open', { account, ...(marketId !== undefined ? { market_id: String(marketId) } : {}) }));
    if (Array.isArray(body)) return body.filter(isRecord) as OpenOrder[];
    if (isRecord(body) && Array.isArray(body.orders)) return body.orders.filter(isRecord) as OpenOrder[];
    return [];
  }

  async getOrderHistory(account: string, marketId?: number, limit = 50): Promise<OrderHistoryEntry[]> {
    const body = unwrapData(await this.http.get('/v1/orders', { account, limit: String(limit), ...(marketId !== undefined ? { market_id: String(marketId) } : {}) }));
    if (Array.isArray(body)) return body.filter(isRecord) as OrderHistoryEntry[];
    if (isRecord(body) && Array.isArray(body.orders)) return body.orders.filter(isRecord) as OrderHistoryEntry[];
    return [];
  }

  async getAccountTradeHistory(account: string, marketId?: number, limit = 50): Promise<Fill[]> {
    const body = unwrapData(await this.http.get('/v1/trade-history', { account, limit: String(limit), ...(marketId !== undefined ? { market_id: String(marketId) } : {}) }));
    if (Array.isArray(body)) return body.filter(isRecord) as Fill[];
    if (isRecord(body) && Array.isArray(body.fills)) return body.fills.filter(isRecord) as Fill[];
    if (isRecord(body) && Array.isArray(body.trades)) return body.trades.filter(isRecord) as Fill[];
    return [];
  }

  async getSessionKeyStatus(account: string, signer: string): Promise<SessionKeyStatus> {
    return ensureRecord(unwrapData(await this.http.get('/v1/auth/session-key-status', { account, signer }))) as unknown as SessionKeyStatus;
  }

  async listSigners(account: string): Promise<SignerInfo[]> {
    const body = unwrapData(await this.http.get('/v1/auth/signers', { account }));
    if (Array.isArray(body)) return body.filter(isRecord) as SignerInfo[];
    if (isRecord(body) && Array.isArray(body.signers)) return body.signers.filter(isRecord) as SignerInfo[];
    return [];
  }
}

function unwrapData(payload: unknown): unknown {
  let current = payload;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!isRecord(current) || !('data' in current)) return current;
    current = current.data;
  }
  return current;
}

function requireString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return String(value);
  }
  throw new Error(`Missing required field: ${keys.join(' | ')}`);
}

function ensureRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Expected RISEx object payload');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
