import type { BestBidOffer, ExecutionAdapter, ExecutionOrder, ExecutionOrderRequest, ExchangePosition, MarketMetadata, PriceRequest } from '@btc-arbitrage/exchange-core';
import { findMarket, getMarketId } from '../market-normalization.js';
import type { ExtendedConfig } from './extended.types.js';
import { createExtendedOrderContext, createExtendedSignedOrder, initExtendedSigningWasm, roundDecimalToStep, type ExtendedFees, type ExtendedOrderSide, type ExtendedSigningMarket, type ExtendedStarknetDomain } from './extended-order-signing.js';

interface ExtendedHttpApi {
  get(path: string, options?: { private?: boolean; query?: Record<string, string | number | boolean | Array<string | number | boolean> | undefined> }): Promise<unknown>;
  post?(path: string, body: unknown, options?: { private?: boolean; query?: Record<string, string | number | boolean | Array<string | number | boolean> | undefined> }): Promise<unknown>;
  delete?(path: string, options?: { private?: boolean; query?: Record<string, string | number | boolean | Array<string | number | boolean> | undefined> }): Promise<unknown>;
}

const MARKET_CROSSING_BUFFER_BPS = 150;
const MARKET_PRICE_CAP_BPS = 500;

export function createExtendedExecutionAdapter(config: ExtendedConfig, http: ExtendedHttpApi): ExecutionAdapter {
  return new ExtendedExecutionAdapter(config, http);
}

export function assertExtendedTradingUnsupported(): never {
  throw new Error('Extended trade execution is intentionally not implemented in this slice. Use dry-run monitoring only.');
}

class ExtendedExecutionAdapter implements ExecutionAdapter {
  constructor(private readonly config: ExtendedConfig, private readonly http: ExtendedHttpApi) {}

  async getBestBidOffer(input: PriceRequest): Promise<BestBidOffer> {
    const market = await this.getMarket(input);
    const orderbook = unwrapData(await this.http.get(`/api/v1/info/markets/${encodeURIComponent(getMarketName(market))}/orderbook`));
    const bidUsd = firstPrice(orderbook, 'bid');
    const askUsd = firstPrice(orderbook, 'ask');
    return { bidUsd, askUsd, receivedAt: new Date() };
  }

  async getMarketMetadata(input: PriceRequest): Promise<MarketMetadata> {
    const market = await this.getMarket(input);
    const tradingConfig = requiredRecord(market.tradingConfig, 'Extended market tradingConfig');
    return {
      minQuantityBase: decimalField(tradingConfig, ['minOrderSize'], 'market.tradingConfig.minOrderSize'),
      quantityStepBase: decimalField(tradingConfig, ['minOrderSizeChange'], 'market.tradingConfig.minOrderSizeChange'),
      maxLeverage: optionalNumber(tradingConfig.maxLeverage),
      positionMode: 'one-way'
    };
  }

  async getAvailableMarginUsd(): Promise<string> {
    this.requireApiKey();
    const balance = unwrapData(await this.http.get('/api/v1/user/balance', { private: true }));
    if (isRecord(balance) && balance.syntheticZeroBalance === true) return '0';
    return findDecimal(balance, ['availableForTrade', 'availableForTrading', 'availableForWithdrawal', 'availableBalance', 'balance', 'equity']) ?? fail('Extended balance response did not include available margin');
  }

  async validateExecutionPreflight(input: { symbol: string; leverage: number }): Promise<void> {
    this.requireTradingEnabled();
    this.requireCredentials();
    const [metadata, availableMargin] = await Promise.all([
      this.getMarketMetadata({ symbol: input.symbol, marketType: 'perpetual', priceSource: 'last' }),
      this.getAvailableMarginUsd()
    ]);
    if (metadata.maxLeverage !== undefined && input.leverage > metadata.maxLeverage) throw new Error(`Extended leverage ${input.leverage} exceeds market max ${metadata.maxLeverage}`);
    if (Number(availableMargin) <= 0) throw new Error('Extended available margin is zero');
    await initExtendedSigningWasm();
  }

  async submitExecutionOrder(input: ExecutionOrderRequest): Promise<ExecutionOrder> {
    this.requireTradingEnabled();
    this.requireCredentials();
    if (!this.http.post) throw new Error('Extended HTTP client does not support POST');

    const market = await this.getMarket({ symbol: input.symbol, marketType: 'perpetual', priceSource: 'last' });
    const marketName = getMarketName(market);
    const [fees, starknetDomain] = await Promise.all([this.getFees(marketName), this.getStarknetDomain()]);
    const ctx = createExtendedOrderContext({ market: toSigningMarket(market), fees, starknetDomain, vaultId: this.config.vaultId!, starkPrivateKey: this.config.starkPrivateKey! });
    const side = toExtendedSide(input.side);
    const quantity = roundDecimalToStep(input.quantityBase, metadataStep(market), 'down');
    const order = await this.createOrderPayload(input, market, marketName, side, quantity, ctx);
    const placed = unwrapData(await this.http.post('/api/v1/user/order', order, { private: true }));
    const placedId = stringField(placed, ['id'], 'Extended order placement id');

    if (input.type === 'market') {
      try {
        return await this.getExecutionOrder(placedId);
      } catch {
        return { id: placedId, status: 'new', filledQuantityBase: '0' };
      }
    }
    return { id: placedId, status: 'new', filledQuantityBase: '0' };
  }

  async getExecutionOrder(orderId: string): Promise<ExecutionOrder> {
    this.requireApiKey();
    const order = unwrapData(await this.http.get(`/api/v1/user/orders/${encodeURIComponent(orderId)}`, { private: true }));
    return mapExecutionOrder(order);
  }

  async cancelExecutionOrder(orderId: string): Promise<void> {
    this.requireTradingEnabled();
    this.requireApiKey();
    if (!this.http.delete) throw new Error('Extended HTTP client does not support DELETE');
    await this.http.delete(`/api/v1/user/order/${encodeURIComponent(orderId)}`, { private: true });
  }

  async getPosition(input: { symbol: string; side: 'long' | 'short' }): Promise<ExchangePosition | null> {
    this.requireApiKey();
    const market = await this.getMarket({ symbol: input.symbol, marketType: 'perpetual', priceSource: 'last' });
    const side = input.side.toUpperCase();
    const payload = unwrapData(await this.http.get('/api/v1/user/positions', { private: true, query: { market: getMarketName(market), side } }));
    const position = asRecords(payload).find((item) => normalizeSide(item.side) === input.side);
    if (!position) return null;
    const quantityBase = findDecimal(position, ['size', 'qty', 'quantity']) ?? '0';
    if (Number(quantityBase) === 0) return null;
    return {
      id: optionalString(position.id),
      side: input.side,
      quantityBase,
      entryPriceUsd: findDecimal(position, ['openPrice', 'entryPrice', 'averageEntryPrice']),
      status: 'open'
    };
  }

  private async createOrderPayload(input: ExecutionOrderRequest, market: Record<string, unknown>, marketName: string, side: ExtendedOrderSide, quantity: string, ctx: ReturnType<typeof createExtendedOrderContext>) {
    const minPriceChange = priceStep(market);
    if (input.type === 'limit') {
      if (!input.priceUsd) throw new Error('Extended limit order requires priceUsd');
      return createExtendedSignedOrder({ marketName, orderType: 'LIMIT', side, amountOfSynthetic: quantity, price: roundDecimalToStep(input.priceUsd, minPriceChange, side === 'BUY' ? 'up' : 'down'), timeInForce: 'GTT', reduceOnly: input.reduceOnly ?? false, postOnly: input.reduceOnly ? false : true, ctx });
    }
    if (input.type === 'market') {
      const price = await this.crossingPrice(marketName, side, minPriceChange);
      return createExtendedSignedOrder({ marketName, orderType: 'MARKET', side, amountOfSynthetic: quantity, price, timeInForce: 'IOC', reduceOnly: input.reduceOnly ?? false, postOnly: false, ctx });
    }
    if (input.type === 'take-profit-market' || input.type === 'stop-market') {
      if (!input.triggerPriceUsd) throw new Error('Extended TP/SL order requires triggerPriceUsd');
      if (!input.reduceOnly) throw new Error('Extended TP/SL execution orders must be reduce-only');
      const triggerPrice = roundDecimalToStep(input.triggerPriceUsd, minPriceChange, side === 'BUY' ? 'up' : 'down');
      const executionPrice = roundDecimalToStep(applyBps(input.triggerPriceUsd, side === 'BUY' ? 10_000 + MARKET_CROSSING_BUFFER_BPS : 10_000 - MARKET_CROSSING_BUFFER_BPS), minPriceChange, side === 'BUY' ? 'up' : 'down');
      const trigger = { triggerPrice, triggerPriceType: 'LAST' as const, price: executionPrice, priceType: 'MARKET' as const };
      return createExtendedSignedOrder({ marketName, orderType: 'TPSL', side, amountOfSynthetic: quantity, price: '0', timeInForce: 'GTT', reduceOnly: true, postOnly: false, tpSlType: 'ORDER', takeProfit: input.type === 'take-profit-market' ? trigger : undefined, stopLoss: input.type === 'stop-market' ? trigger : undefined, ctx });
    }
    throw new Error(`Unsupported Extended order type: ${input.type}`);
  }

  private async crossingPrice(marketName: string, side: ExtendedOrderSide, minPriceChange: string): Promise<string> {
    const orderbook = unwrapData(await this.http.get(`/api/v1/info/markets/${encodeURIComponent(marketName)}/orderbook`));
    const best = side === 'BUY' ? firstPrice(orderbook, 'ask') : firstPrice(orderbook, 'bid');
    return roundDecimalToStep(applyBps(best, side === 'BUY' ? 10_000 + MARKET_CROSSING_BUFFER_BPS : 10_000 - MARKET_CROSSING_BUFFER_BPS), minPriceChange, side === 'BUY' ? 'up' : 'down');
  }

  private async getMarket(input: PriceRequest): Promise<Record<string, unknown>> {
    const payload = await this.http.get('/api/v1/info/markets');
    return findMarket(payload, input.symbol, input.marketType);
  }

  private async getFees(marketName: string): Promise<ExtendedFees> {
    this.requireApiKey();
    const payload = unwrapData(await this.http.get('/api/v1/user/fees', { private: true, query: { market: marketName } }));
    const fees = asRecords(payload)[0] ?? fail('Extended fees response did not include fee data');
    return { makerFeeRate: decimalField(fees, ['makerFeeRate'], 'makerFeeRate'), takerFeeRate: decimalField(fees, ['takerFeeRate'], 'takerFeeRate'), builderFeeRate: optionalDecimal(fees.builderFeeRate) };
  }

  private async getStarknetDomain(): Promise<ExtendedStarknetDomain> {
    const payload = unwrapData(await this.http.get('/api/v1/info/starknet'));
    const domain = requiredRecord(payload, 'Extended starknet domain');
    return { name: stringField(domain, ['name'], 'starknet.name'), version: stringField(domain, ['version'], 'starknet.version'), chainId: stringField(domain, ['chainId'], 'starknet.chainId'), revision: Number(decimalField(domain, ['revision'], 'starknet.revision')) };
  }

  private requireTradingEnabled(): void {
    if (!this.config.tradingEnabled) throw new Error('Extended trading is disabled; set EXTENDED_TRADING_ENABLED=true only after credentials and risk controls are ready');
  }

  private requireCredentials(): void {
    this.requireApiKey();
    if (!this.config.starkPrivateKey) throw new Error('EXTENDED_STARK_PRIVATE_KEY is required for Extended live execution');
    if (!this.config.vaultId) throw new Error('EXTENDED_VAULT_ID is required for Extended live execution');
  }

  private requireApiKey(): void {
    if (!this.config.apiKey) throw new Error('EXTENDED_API_KEY is required for Extended private REST requests');
  }
}

function toSigningMarket(market: Record<string, unknown>): ExtendedSigningMarket {
  const l2Config = requiredRecord(market.l2Config, 'Extended market l2Config');
  const tradingConfig = requiredRecord(market.tradingConfig, 'Extended market tradingConfig');
  return {
    name: getMarketName(market),
    l2Config: {
      collateralId: stringField(l2Config, ['collateralId'], 'l2Config.collateralId'),
      collateralResolution: decimalField(l2Config, ['collateralResolution'], 'l2Config.collateralResolution'),
      syntheticId: stringField(l2Config, ['syntheticId'], 'l2Config.syntheticId'),
      syntheticResolution: decimalField(l2Config, ['syntheticResolution'], 'l2Config.syntheticResolution')
    },
    tradingConfig: {
      minOrderSizeChange: decimalField(tradingConfig, ['minOrderSizeChange'], 'tradingConfig.minOrderSizeChange'),
      maxPositionValue: decimalField(tradingConfig, ['maxPositionValue'], 'tradingConfig.maxPositionValue')
    }
  };
}

function mapExecutionOrder(payload: unknown): ExecutionOrder {
  const order = requiredRecord(payload, 'Extended order');
  return {
    id: stringField(order, ['id'], 'order.id'),
    status: mapOrderStatus(stringField(order, ['status'], 'order.status')),
    filledQuantityBase: findDecimal(order, ['filledQty', 'filledQuantity', 'cumQty', 'executedQty']) ?? '0',
    averageFillPriceUsd: findDecimal(order, ['averagePrice', 'averageFillPrice', 'avgPrice'])
  };
}

function mapOrderStatus(status: string): ExecutionOrder['status'] {
  switch (status.toUpperCase()) {
    case 'NEW':
    case 'UNTRIGGERED': return 'new';
    case 'PARTIALLY_FILLED': return 'partially_filled';
    case 'FILLED': return 'filled';
    case 'CANCELLED':
    case 'EXPIRED': return 'cancelled';
    case 'REJECTED': return 'rejected';
    default: return 'new';
  }
}

function firstPrice(payload: unknown, side: 'bid' | 'ask'): string {
  const book = requiredRecord(payload, 'Extended orderbook');
  const levels = book[side];
  if (!Array.isArray(levels) || levels.length === 0) throw new Error(`Extended orderbook ${side} side is empty`);
  return decimalField(requiredRecord(levels[0], `Extended ${side} level`), ['price'], `${side}.price`);
}

function unwrapData(payload: unknown): unknown {
  return isRecord(payload) && 'data' in payload ? payload.data : payload;
}

function asRecords(payload: unknown): Record<string, unknown>[] {
  const value = unwrapData(payload);
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value) && Array.isArray(value.items)) return value.items.filter(isRecord);
  return isRecord(value) ? [value] : [];
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is missing or invalid`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringField(record: unknown, keys: string[], label: string): string {
  const source = requiredRecord(record, label);
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  throw new Error(`${label} is missing`);
}

function decimalField(record: unknown, keys: string[], label: string): string {
  const value = stringField(record, keys, label);
  if (!/^-?\d+(\.\d+)?$/.test(value)) throw new Error(`${label} must be a decimal string`);
  return value;
}

function optionalDecimal(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  const n = typeof value === 'string' || typeof value === 'number' ? Number(value) : undefined;
  return n !== undefined && Number.isFinite(n) ? n : undefined;
}

function findDecimal(value: unknown, keys: string[]): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const entry = value[key];
    if ((typeof entry === 'string' || typeof entry === 'number') && /^-?\d+(\.\d+)?$/.test(String(entry))) return String(entry);
  }
  for (const entry of Object.values(value)) {
    if (isRecord(entry)) {
      const nested = findDecimal(entry, keys);
      if (nested) return nested;
    }
  }
  return undefined;
}

function getMarketName(market: Record<string, unknown>): string {
  return String(getMarketId(market));
}

function metadataStep(market: Record<string, unknown>): string {
  return decimalField(requiredRecord(market.tradingConfig, 'Extended market tradingConfig'), ['minOrderSizeChange'], 'market.tradingConfig.minOrderSizeChange');
}

function priceStep(market: Record<string, unknown>): string {
  return decimalField(requiredRecord(market.tradingConfig, 'Extended market tradingConfig'), ['minPriceChange'], 'market.tradingConfig.minPriceChange');
}

function toExtendedSide(side: ExecutionOrderRequest['side']): ExtendedOrderSide {
  return side === 'buy' ? 'BUY' : 'SELL';
}

function normalizeSide(side: unknown): 'long' | 'short' | undefined {
  const normalized = String(side ?? '').toUpperCase();
  if (normalized === 'LONG' || normalized === 'BUY') return 'long';
  if (normalized === 'SHORT' || normalized === 'SELL') return 'short';
  return undefined;
}

function applyBps(value: string, bps: number): string {
  const [intPart, fracPart = ''] = value.split('.');
  const scale = 10n ** BigInt(fracPart.length);
  const numerator = BigInt(`${intPart}${fracPart}`) * BigInt(bps);
  const denominator = scale * 10_000n;
  const integer = numerator / denominator;
  let remainder = numerator % denominator;
  if (remainder === 0n) return integer.toString(10);
  let fraction = '';
  while (remainder !== 0n && fraction.length < 40) {
    remainder *= 10n;
    fraction += (remainder / denominator).toString(10);
    remainder %= denominator;
  }
  return `${integer.toString(10)}.${fraction.replace(/0+$/, '')}`;
}

function fail(message: string): never {
  throw new Error(message);
}

export const extendedExecutionInternals = { mapExecutionOrder };
