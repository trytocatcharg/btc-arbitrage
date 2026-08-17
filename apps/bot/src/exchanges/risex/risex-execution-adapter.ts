import { formatDecimal, parseDecimal } from '@btc-arbitrage/domain';
import type { BestBidOffer, ExecutionAdapter, ExecutionOrder, ExecutionOrderRequest, ExchangePosition, MarketMetadata, PriceRequest } from '@btc-arbitrage/exchange-core';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { asArrayPayload, findMarket, getMarketId } from '../market-normalization.js';
import { ExchangeClient } from './sdk/ExchangeClient.js';
import { createNonce } from './sdk/signing/nonce.js';
import { OrderType, Side, StpMode, StopPriceOption, TimeInForce } from './sdk/types/common.js';
import type { RisexConfig } from './risex.types.js';

const MAX_NONCE_BITMAP_INDEX = 207;
const DEFAULT_PERMIT_DEADLINE_SECONDS = 60 * 60;
const EIP712_DOMAIN_TYPE = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';
const VERIFY_WITNESS_TYPE = 'VerifyWitness(address account,address target,bytes32 hash,uint48 nonceAnchor,uint8 nonceBitmap,uint32 deadline)';
const PLACE_ORDER_SELECTOR = 'RISE_PERPS_PLACE_ORDER_V1';
const CANCEL_ORDER_SELECTOR = 'RISE_PERPS_CANCEL_ORDER_V1';
const UPDATE_LEVERAGE_SELECTOR = 'RISE_PERPS_UPDATE_LEVERAGE_V1';

type RisexSide = 0 | 1;
type RisexOrderType = 0 | 1;
type RisexTimeInForce = 0 | 1 | 2 | 3;

interface RisexExecutionHttpClient {
  get(path: string, query?: Record<string, string | undefined>): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
}

interface RisexDomain {
  name: string;
  version: string;
  chainId: bigint;
  verifyingContract: string;
}

interface RisexMarketInfo {
  market: Record<string, unknown>;
  marketId: number;
  minQuantityBase: string;
  quantityStepBase: string;
  priceStepUsd: string;
  maxLeverage?: number;
}

interface RisexOpenOrder {
  id: string;
  marketId: number;
  restingOrderId: bigint;
  sizeSteps?: bigint;
  remainingSizeSteps?: bigint;
  filledSizeSteps?: bigint;
  priceTicks?: bigint;
  status?: string;
  averageFillPriceUsd?: string;
  raw: Record<string, unknown>;
}

interface PermitParams {
  account: string;
  signer: string;
  nonce_anchor: string;
  nonce_bitmap_index: number;
  deadline: number;
  signature: string;
}

export function createRisexExecutionAdapter(config: RisexConfig, http: RisexExecutionHttpClient): ExecutionAdapter {
  return new RisexExecutionAdapter(config, http);
}

export class RisexExecutionAdapter implements ExecutionAdapter {
  private readonly signerAddress?: string;
  private readonly exchangeClient?: ExchangeClient;
  private readonly exchangeClientReady?: Promise<ExchangeClient>;
  private nonceAnchor?: bigint;
  private nextNonceBitmapIndex = 0;

  constructor(private readonly config: RisexConfig, private readonly http: RisexExecutionHttpClient, private readonly now: () => Date = () => new Date()) {
    this.signerAddress = config.sessionSignerPrivateKey ? privateKeyToAddress(config.sessionSignerPrivateKey) : undefined;
    if (config.accountAddress && config.sessionSignerPrivateKey) {
      this.exchangeClient = new ExchangeClient({
        baseUrl: config.apiBaseUrl,
        account: config.accountAddress,
        accountKey: config.accountPrivateKey,
        signerKey: config.sessionSignerPrivateKey
      }, http);
      this.exchangeClientReady = this.exchangeClient.init();
    }
  }

  async getBestBidOffer(input: PriceRequest): Promise<BestBidOffer> {
    const info = await this.getMarketInfo(input);
    const orderbook = await this.getOrderbook(info.marketId);
    return {
      bidUsd: firstOrderbookPrice(orderbook, 'bids', 'RISEx best bid'),
      askUsd: firstOrderbookPrice(orderbook, 'asks', 'RISEx best ask'),
      receivedAt: this.now()
    };
  }

  async getMarketMetadata(input: PriceRequest): Promise<MarketMetadata> {
    const info = await this.getMarketInfo(input);
    return { minQuantityBase: info.minQuantityBase, quantityStepBase: info.quantityStepBase, maxLeverage: info.maxLeverage, positionMode: 'one-way' };
  }

  async getAvailableMarginUsd(): Promise<string> {
    const account = this.requireAccountAddress();
    const payload = await this.http.get('/v1/account/cross-margin-balance', { account });
    const body = unwrapData(payload);
    return requireDecimalDeep(body, ['available_balance', 'availableBalance', 'available_margin', 'availableMargin', 'free_collateral', 'freeCollateral', 'cross_margin_balance', 'crossMarginBalance', 'balance', 'equity'], 'RISEx available margin');
  }

  async validateExecutionPreflight(input: { symbol: string; leverage: number }): Promise<void> {
    this.requireTradingCredentials();
    const info = await this.getMarketInfo({ symbol: input.symbol, marketType: 'perpetual', priceSource: 'last' });
    if (!Number.isInteger(input.leverage) || input.leverage <= 0 || input.leverage > 255) throw new Error('RISEx leverage must be an integer between 1 and 255');
    if (info.maxLeverage && input.leverage > info.maxLeverage) throw new Error(`RISEx leverage ${input.leverage} exceeds market max ${info.maxLeverage}`);
    await (await this.getExchangeClient()).updateLeverage(info.marketId, BigInt(input.leverage));
  }

  async submitExecutionOrder(input: ExecutionOrderRequest): Promise<ExecutionOrder> {
    this.requireTradingCredentials();
    const info = await this.getMarketInfo({ symbol: input.symbol, marketType: 'perpetual', priceSource: 'last' });
    if (input.type === 'take-profit-market' || input.type === 'stop-market') {
      if (!input.triggerPriceUsd) throw new Error('RISEx TP/SL order requires triggerPriceUsd');
      if (!input.reduceOnly) throw new Error('RISEx TP/SL execution orders must be reduce-only');
      const size = normalizeSignedDecimal(input.quantityBase);
      const trigger = roundDecimalToStepString(input.triggerPriceUsd, info.priceStepUsd, input.side === 'buy' ? 'up' : 'down');
      const limit = deriveTpslLimitPrice(trigger, info.priceStepUsd, input.type, input.side);
      const response = input.type === 'take-profit-market'
        ? await (await this.getExchangeClient()).placeTakeProfit({
            market_id: info.marketId,
            side: input.side === 'buy' ? Side.Long : Side.Short,
            size,
            stop_price: trigger,
            limit_price: limit,
            stop_price_option: StopPriceOption.LastTradedPrice,
            tif: TimeInForce.GoodTillCancelled
          })
        : await (await this.getExchangeClient()).placeStopLoss({
            market_id: info.marketId,
            side: input.side === 'buy' ? Side.Long : Side.Short,
            size,
            stop_price: trigger,
            limit_price: limit,
            stop_price_option: StopPriceOption.LastTradedPrice,
            tif: TimeInForce.GoodTillCancelled
          });
      const id = stringField(firstRecord(unwrapData(response)) ?? (response as Record<string, unknown>), ['order_id', 'orderId', 'id']);
      if (!id) throw new Error('RISEx TPSL response did not include order_id');
      return { id, status: 'new', filledQuantityBase: '0' };
    }

    const orderType: RisexOrderType = input.type === 'market' ? 0 : 1;
    const timeInForce: RisexTimeInForce = input.type === 'market' ? 3 : 0;
    const side: RisexSide = input.side === 'sell' ? 1 : 0;
    const sizeSteps = decimalToIntegerUnits(input.quantityBase, info.quantityStepBase, 'RISEx quantity');
    const priceUsd = input.priceUsd ?? await this.getMarketPriceBound(input);
    const priceTicks = priceToTicks(priceUsd, info.priceStepUsd, input.side, input.type);
    const postOnly = input.type === 'limit';
    const reduceOnly = input.reduceOnly === true;

    const response = await (await this.getExchangeClient()).placeOrder({
      market_id: info.marketId,
      size_steps: Number(sizeSteps),
      price_ticks: Number(priceTicks),
      side: side === 0 ? Side.Long : Side.Short,
      post_only: postOnly,
      reduce_only: reduceOnly,
      stp_mode: StpMode.ExpireMaker,
      order_type: orderType === 0 ? OrderType.Market : OrderType.Limit,
      time_in_force: timeInForce === 3 ? TimeInForce.ImmediateOrCancel : TimeInForce.GoodTillCancelled,
      ttl_units: 0,
      client_order_id: normalizeClientOrderId(input.clientOrderId, this.requireAccountAddress())
    });

    return normalizeSubmittedOrder(response, info);
  }

  async getExecutionOrder(orderId: string): Promise<ExecutionOrder> {
    const order = await this.requireOpenOrder(orderId);
    return normalizeOpenOrder(order, undefined);
  }

  async cancelExecutionOrder(orderId: string): Promise<void> {
    this.requireTradingCredentials();
    const order = await this.requireOpenOrder(orderId);
    await (await this.getExchangeClient()).cancelOrder({ market_id: order.marketId, order_id: order.id, resting_order_id: order.restingOrderId.toString() });
  }

  async getPosition(input: { symbol: string; side: 'long' | 'short' }): Promise<ExchangePosition | null> {
    const account = this.requireAccountAddress();
    const info = await this.getMarketInfo({ symbol: input.symbol, marketType: 'perpetual', priceSource: 'last' });
    const payload = await this.http.get('/v1/account/position', { account, market_id: String(info.marketId) });
    const body = firstRecord(unwrapData(payload));
    if (!body) return { side: input.side, quantityBase: '0', status: 'closed', closeReason: 'unknown' };
    const signedQuantity = optionalSignedDecimalDeep(body, ['quantity', 'quantity_base', 'quantityBase', 'size', 'size_base', 'sizeBase', 'position_size', 'positionSize']);
    if (!signedQuantity || parseDecimal(signedQuantity) === 0) return { id: stringField(body, ['id', 'position_id', 'positionId']), side: input.side, quantityBase: '0', status: 'closed', closeReason: normalizeCloseReason(body) };
    const quantity = parseDecimal(signedQuantity);
    const actualSide = quantity < 0 ? 'short' : 'long';
    if (actualSide !== input.side) return { id: stringField(body, ['id', 'position_id', 'positionId']), side: input.side, quantityBase: '0', status: 'closed', closeReason: 'unknown' };
    return { id: stringField(body, ['id', 'position_id', 'positionId']), side: actualSide, quantityBase: formatDecimal(Math.abs(quantity), 10), entryPriceUsd: optionalDecimalDeep(body, ['entry_price', 'entryPrice', 'avg_entry_price', 'averageEntryPrice']), status: 'open' };
  }

  async getOpenOrders(input?: { symbol?: string }): Promise<RisexOpenOrder[]> {
    const account = this.requireAccountAddress();
    let marketId: string | undefined;
    if (input?.symbol) {
      const info = await this.getMarketInfo({ symbol: input.symbol, marketType: 'perpetual', priceSource: 'last' });
      marketId = String(info.marketId);
    }
    const payload = await this.http.get('/v1/orders/open', { account, market_id: marketId });
    return asRisexArrayPayload(payload).filter(isRecord).map(normalizeRawOpenOrder);
  }

  async getOpenTpslOrders(input?: { symbol?: string }): Promise<unknown[]> {
    const account = this.requireAccountAddress();
    let marketId: string | undefined;
    if (input?.symbol) {
      const info = await this.getMarketInfo({ symbol: input.symbol, marketType: 'perpetual', priceSource: 'last' });
      marketId = String(info.marketId);
    }
    const payload = await this.http.get('/v1/orders/tpsl', { account, market_id: marketId });
    return asRisexArrayPayload(payload);
  }

  private async getMarketPriceBound(input: ExecutionOrderRequest): Promise<string> {
    const bbo = await this.getBestBidOffer({ symbol: input.symbol, marketType: 'perpetual', priceSource: 'last' });
    return input.side === 'buy' ? bbo.askUsd : bbo.bidUsd;
  }

  private async getMarketInfo(input: PriceRequest): Promise<RisexMarketInfo> {
    const payload = await this.http.get('/v1/markets');
    const market = findMarket(payload, input.symbol, input.marketType);
    const config = nestedRecord(market, 'config');
    const minQuantityBase = requireDecimalFromRecords([config, market], ['min_order_size', 'minOrderSize', 'min_size', 'minSize'], 'RISEx min order size');
    const quantityStepBase = requireDecimalFromRecords([config, market], ['step_size', 'stepSize', 'quantity_step', 'quantityStep'], 'RISEx quantity step');
    const priceStepUsd = requireDecimalFromRecords([config, market], ['step_price', 'stepPrice', 'tick_size', 'tickSize', 'price_step', 'priceStep'], 'RISEx price step');
    return { market, marketId: parseMarketId(getMarketId(market)), minQuantityBase, quantityStepBase, priceStepUsd, maxLeverage: optionalIntegerFromRecords([config, market], ['max_leverage', 'maxLeverage']) };
  }

  private async getOrderbook(marketId: number): Promise<Record<string, unknown>> {
    const payload = await this.http.get('/v1/orderbook', { market_id: String(marketId), limit: '1' });
    const body = unwrapData(payload);
    if (!isRecord(body)) throw new Error('RISEx orderbook response was not an object');
    return body;
  }

  private async requireOpenOrder(orderId: string): Promise<RisexOpenOrder> {
    const order = (await this.getOpenOrders()).find((candidate) => candidate.id === orderId || normalizeHex(candidate.id) === normalizeHex(orderId));
    if (!order) throw new Error(`RISEx open order ${orderId} was not found; fill history is not documented, so status cannot be inferred safely`);
    return order;
  }

  private requireAccountAddress(): string {
    if (!this.config.accountAddress) throw new Error('RISEX_ACCOUNT_ADDRESS is required for RISEx account-scoped reads');
    return normalizeAddress(this.config.accountAddress);
  }

  private requireTradingCredentials(): void {
    if (!this.config.tradingEnabled) throw new Error('RISEx live execution is disabled; set RISEX_TRADING_ENABLED=true to allow signed REST mutations');
    this.requireAccountAddress();
    if (!this.config.sessionSignerPrivateKey || !this.signerAddress) throw new Error('RISEX_SESSION_SIGNER_PRIVATE_KEY is required for RISEx signed REST mutations');
  }

  private async getExchangeClient(): Promise<ExchangeClient> {
    this.requireTradingCredentials();
    if (!this.exchangeClient || !this.exchangeClientReady) throw new Error('RISEx exchange client could not be initialized');
    return this.exchangeClientReady;
  }

  private async createPermit(actionHash: Uint8Array): Promise<PermitParams> {
    const account = this.requireAccountAddress();
    if (!this.config.sessionSignerPrivateKey || !this.signerAddress) throw new Error('RISEX_SESSION_SIGNER_PRIVATE_KEY is required for RISEx permit signing');
    const [domain, router, nonce] = await Promise.all([this.getDomain(), this.getRouterAddress(), this.nextNonce()]);
    const deadline = Math.floor(this.now().getTime() / 1000) + DEFAULT_PERMIT_DEADLINE_SECONDS;
    const signature = signVerifyWitnessPermit({ privateKey: this.config.sessionSignerPrivateKey, domain, account, target: router, actionHash, nonceAnchor: nonce.anchor, nonceBitmap: nonce.bitmapIndex, deadline });
    return { account, signer: this.signerAddress, nonce_anchor: String(nonce.anchor), nonce_bitmap_index: nonce.bitmapIndex, deadline, signature };
  }

  private async getDomain(): Promise<RisexDomain> {
    const body = unwrapData(await this.http.get('/v1/auth/eip712-domain'));
    if (!isRecord(body)) throw new Error('RISEx EIP-712 domain response was not an object');
    const name = stringField(body, ['name']);
    const version = stringField(body, ['version']);
    const chainId = stringField(body, ['chain_id', 'chainId']);
    const verifyingContract = stringField(body, ['verifying_contract', 'verifyingContract']);
    if (!name || !version || !chainId || !verifyingContract) throw new Error('RISEx EIP-712 domain response is missing required fields');
    return { name, version, chainId: BigInt(chainId), verifyingContract: normalizeAddress(verifyingContract) };
  }

  private async getRouterAddress(): Promise<string> {
    const body = unwrapData(await this.http.get('/v1/system/config'));
    if (!isRecord(body)) throw new Error('RISEx system config response was not an object');
    const addresses = nestedRecord(body, 'addresses');
    const router = stringField(addresses, ['router']);
    if (!router) throw new Error('RISEx system config response is missing addresses.router');
    return normalizeAddress(router);
  }

  private async nextNonce(): Promise<{ anchor: bigint; bitmapIndex: number }> {
    if (this.nonceAnchor === undefined || this.nextNonceBitmapIndex > MAX_NONCE_BITMAP_INDEX) {
      const body = unwrapData(await this.http.get(`/v1/nonce-state/${this.requireAccountAddress()}`));
      if (!isRecord(body)) throw new Error('RISEx nonce state response was not an object');
      const anchor = stringField(body, ['nonce_anchor', 'nonceAnchor']);
      if (!anchor) throw new Error('RISEx nonce state response is missing nonce_anchor');
      this.nonceAnchor = BigInt(anchor) + 1n;
      this.nextNonceBitmapIndex = 0;
    }
    const bitmapIndex = this.nextNonceBitmapIndex;
    this.nextNonceBitmapIndex += 1;
    return { anchor: this.nonceAnchor, bitmapIndex };
  }
}

export function createRisexPlaceOrderActionHash(input: { marketId: number; sizeSteps: bigint; priceTicks: bigint; side: RisexSide; postOnly: boolean; reduceOnly: boolean; stpMode: number; orderType: RisexOrderType; timeInForce: RisexTimeInForce }): Uint8Array {
  const orderData = packRisexOrderData(input);
  return keccakBytes(concatBytes(selectorHash(PLACE_ORDER_SELECTOR), abiWord(0x01), abiWord(orderData), abiWord(0), abiWord(0), abiWord(0)));
}

export function createRisexCancelOrderActionHash(input: { marketId: number; restingOrderId: bigint }): Uint8Array {
  return keccakBytes(concatBytes(selectorHash(CANCEL_ORDER_SELECTOR), abiWord(input.marketId), abiWord(input.restingOrderId)));
}

export function createRisexUpdateLeverageActionHash(input: { marketId: number; leverage: number }): Uint8Array {
  return keccakBytes(concatBytes(selectorHash(UPDATE_LEVERAGE_SELECTOR), abiWord(input.marketId), abiWord(input.leverage)));
}

export function packRisexOrderData(input: { marketId: number; sizeSteps: bigint; priceTicks: bigint; side: RisexSide; postOnly: boolean; reduceOnly: boolean; stpMode: number; orderType: RisexOrderType; timeInForce: RisexTimeInForce }): bigint {
  assertUint(input.marketId, 16, 'marketId');
  assertUint(input.sizeSteps, 32, 'sizeSteps');
  assertUint(input.priceTicks, 24, 'priceTicks');
  assertUint(input.stpMode, 2, 'stpMode');
  const flags = BigInt((input.side & 1) | (input.postOnly ? 1 << 1 : 0) | (input.reduceOnly ? 1 << 2 : 0) | ((input.stpMode & 3) << 3) | ((input.orderType & 1) << 5) | ((input.timeInForce & 3) << 6));
  return (BigInt(input.marketId) << 70n) | (input.sizeSteps << 38n) | (input.priceTicks << 14n) | (flags << 6n) | (1n << 1n);
}

export function signVerifyWitnessPermit(input: { privateKey: string; domain: RisexDomain; account: string; target: string; actionHash: Uint8Array; nonceAnchor: bigint; nonceBitmap: number; deadline: number }): string {
  const digest = createVerifyWitnessDigest(input);
  const signature = secp256k1.sign(digest, hexToBytes(normalizePrivateKey(input.privateKey)));
  const r = bigintToBytes(signature.r, 32);
  const s = bigintToBytes(signature.s, 32);
  if (signature.recovery === 1) s[0] |= 0x80;
  return Buffer.from(concatBytes(r, s)).toString('base64');
}

function createVerifyWitnessDigest(input: { domain: RisexDomain; account: string; target: string; actionHash: Uint8Array; nonceAnchor: bigint; nonceBitmap: number; deadline: number }): Uint8Array {
  const domainSeparator = keccakBytes(concatBytes(typeHash(EIP712_DOMAIN_TYPE), hashString(input.domain.name), hashString(input.domain.version), abiWord(input.domain.chainId), addressWord(input.domain.verifyingContract)));
  const structHash = keccakBytes(concatBytes(typeHash(VERIFY_WITNESS_TYPE), addressWord(input.account), addressWord(input.target), bytes32Word(input.actionHash), abiWord(input.nonceAnchor), abiWord(input.nonceBitmap), abiWord(input.deadline)));
  return keccakBytes(concatBytes(Uint8Array.from([0x19, 0x01]), domainSeparator, structHash));
}

function normalizeSubmittedOrder(payload: unknown, info: RisexMarketInfo): ExecutionOrder {
  const body = firstRecord(unwrapData(payload));
  if (!body) throw new Error('RISEx place order response did not include an order object');
  const id = stringField(body, ['order_id', 'orderId', 'id']);
  if (!id) throw new Error('RISEx place order response did not include order_id');
  const averageFillPriceUsd = optionalDecimalDeep(body, ['average_fill_price', 'averageFillPrice', 'avg_fill_price', 'avgFillPrice', 'fill_price', 'fillPrice']) ?? (isFilledStatus(body) ? optionalDecimalDeep(body, ['price', 'price_usd', 'priceUsd']) : undefined);
  return removeUndefined({
    id,
    status: normalizeOrderStatus(stringField(body, ['status', 'order_status', 'orderStatus']) ?? 'new'),
    filledQuantityBase: normalizeFilledQuantity(body, info) ?? optionalDecimalDeep(body, ['filled_quantity', 'filledQuantity', 'filled_size', 'filledSize']) ?? '0',
    averageFillPriceUsd
  });
}

function normalizeOpenOrder(order: RisexOpenOrder, info: RisexMarketInfo | undefined): ExecutionOrder {
  return { id: order.id, status: normalizeOrderStatus(order.status ?? 'new'), filledQuantityBase: order.filledSizeSteps !== undefined && info ? formatDecimal(Number(order.filledSizeSteps) * parseDecimal(info.quantityStepBase), 10) : '0', averageFillPriceUsd: order.averageFillPriceUsd };
}

function normalizeRawOpenOrder(record: Record<string, unknown>): RisexOpenOrder {
  const id = stringField(record, ['order_id', 'orderId', 'id']);
  if (!id) throw new Error('RISEx open order did not include order_id');
  const marketId = parseMarketId(stringField(record, ['market_id', 'marketId']) ?? record.market_id ?? record.marketId);
  return {
    id,
    marketId,
    restingOrderId: extractRestingOrderId(record),
    sizeSteps: optionalBigInt(record, ['size_steps', 'sizeSteps']),
    remainingSizeSteps: optionalBigInt(record, ['remaining_size_steps', 'remainingSizeSteps']),
    filledSizeSteps: optionalBigInt(record, ['filled_size_steps', 'filledSizeSteps']),
    priceTicks: optionalBigInt(record, ['price_ticks', 'priceTicks']),
    status: stringField(record, ['status', 'order_status', 'orderStatus']),
    averageFillPriceUsd: optionalDecimalDeep(record, ['average_fill_price', 'averageFillPrice', 'avg_fill_price', 'avgFillPrice']),
    raw: record
  };
}

function normalizeFilledQuantity(record: Record<string, unknown>, info: RisexMarketInfo): string | undefined {
  const filledSteps = optionalBigInt(record, ['filled_size_steps', 'filledSizeSteps']);
  if (filledSteps === undefined) return undefined;
  return formatDecimal(Number(filledSteps) * parseDecimal(info.quantityStepBase), 10);
}

function isFilledStatus(record: Record<string, unknown>): boolean {
  return normalizeOrderStatus(stringField(record, ['status', 'order_status', 'orderStatus']) ?? '') === 'filled';
}

function extractRestingOrderId(record: Record<string, unknown>): bigint {
  const explicit = optionalBigInt(record, ['resting_order_id', 'restingOrderId']);
  if (explicit !== undefined) return explicit;
  const wide = optionalBigInt(record, ['wide_order_id', 'wideOrderId']);
  if (wide !== undefined) return wide >> 1n;
  throw new Error('RISEx open order did not include resting_order_id or wide_order_id');
}

function normalizeOrderStatus(status: string): ExecutionOrder['status'] {
  const normalized = status.toLowerCase();
  if (['filled', 'fully_filled', 'done'].includes(normalized)) return 'filled';
  if (['partially_filled', 'partial', 'partiallyfilled'].includes(normalized)) return 'partially_filled';
  if (['cancelled', 'canceled'].includes(normalized)) return 'cancelled';
  if (['rejected', 'failed'].includes(normalized)) return 'rejected';
  return 'new';
}

function normalizeCloseReason(record: Record<string, unknown>): ExchangePosition['closeReason'] {
  const reason = stringField(record, ['close_reason', 'closeReason', 'reason'])?.toLowerCase();
  if (reason === 'tp' || reason === 'sl' || reason === 'manual' || reason === 'liquidation') return reason;
  return 'unknown';
}

function priceToTicks(value: string, step: string, side: 'buy' | 'sell', type: ExecutionOrderRequest['type']): bigint {
  const rounding: 'floor' | 'ceil' = type === 'market' ? (side === 'buy' ? 'ceil' : 'floor') : (side === 'buy' ? 'floor' : 'ceil');
  return decimalToIntegerUnits(value, step, 'RISEx price', rounding);
}

function decimalToIntegerUnits(value: string, step: string, field: string, rounding: 'exact' | 'floor' | 'ceil' = 'exact'): bigint {
  const numerator = parseDecimalParts(value);
  const denominator = parseDecimalParts(step);
  const scale = 10n ** BigInt(Math.max(numerator.scale, denominator.scale));
  const scaledValue = numerator.units * (scale / (10n ** BigInt(numerator.scale)));
  const scaledStep = denominator.units * (scale / (10n ** BigInt(denominator.scale)));
  if (scaledStep <= 0n) throw new Error(`${field} step must be positive`);
  const quotient = scaledValue / scaledStep;
  const remainder = scaledValue % scaledStep;
  if (remainder === 0n) return quotient;
  if (rounding === 'floor') return quotient;
  if (rounding === 'ceil') return quotient + 1n;
  throw new Error(`${field} must be an exact multiple of RISEx step ${step}`);
}

function parseDecimalParts(value: string): { units: bigint; scale: number } {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error(`Invalid unsigned decimal: ${value}`);
  const [whole, fractional = ''] = trimmed.split('.');
  return { units: BigInt(`${whole}${fractional}`), scale: fractional.length };
}

function requireDecimalDeep(value: unknown, keys: string[], label: string): string {
  const found = optionalDecimalDeep(value, keys);
  if (!found) throw new Error(`${label} was not present in RISEx payload`);
  return found;
}

function optionalDecimalDeep(value: unknown, keys: string[], depth = 0): string | undefined {
  if (depth > 5) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = optionalDecimalDeep(item, keys, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const candidate = primitiveDecimal(value[key]);
    if (candidate) return candidate;
  }
  for (const item of Object.values(value)) {
    const found = optionalDecimalDeep(item, keys, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function optionalSignedDecimalDeep(value: unknown, keys: string[], depth = 0): string | undefined {
  if (depth > 5) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = optionalSignedDecimalDeep(item, keys, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === 'string' && /^[-+]?\d+(\.\d+)?$/.test(raw.trim())) return raw;
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  }
  for (const item of Object.values(value)) {
    const found = optionalSignedDecimalDeep(item, keys, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function requireDecimalFromRecords(records: Array<Record<string, unknown> | undefined>, keys: string[], label: string): string {
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const value = primitiveDecimal(record[key]);
      if (value) return value;
    }
  }
  throw new Error(`${label} was not present in RISEx market payload`);
}

function firstOrderbookPrice(orderbook: Record<string, unknown>, side: 'bids' | 'asks', label: string): string {
  const levels = orderbook[side];
  if (!Array.isArray(levels) || levels.length === 0) throw new Error(`${label} was not present in RISEx orderbook payload`);
  const first = levels.find(isRecord) as Record<string, unknown> | undefined;
  const price = first ? primitiveDecimal(first.price) : undefined;
  if (!price) throw new Error(`${label} was not present in RISEx orderbook payload`);
  return price;
}

function optionalIntegerFromRecords(records: Array<Record<string, unknown> | undefined>, keys: string[]): number | undefined {
  const value = optionalStringFromRecords(records, keys);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function optionalStringFromRecords(records: Array<Record<string, unknown> | undefined>, keys: string[]): string | undefined {
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' || typeof value === 'number') return String(value);
    }
  }
  return undefined;
}

function primitiveDecimal(value: unknown): string | undefined {
  if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function stringField(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return String(value);
  }
  return undefined;
}

function optionalBigInt(record: Record<string, unknown>, keys: string[]): bigint | undefined {
  const value = stringField(record, keys);
  if (value === undefined) return undefined;
  return parseIntegerLike(value);
}

function parseMarketId(value: unknown): number {
  const parsed = Number(typeof value === 'string' ? value : String(value));
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) throw new Error(`RISEx market_id must be a uint16, got ${String(value)}`);
  return parsed;
}

function parseIntegerLike(value: string): bigint {
  if (/^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value);
  if (/^\d+$/.test(value)) return BigInt(value);
  throw new Error(`Expected integer-like value, got ${value}`);
}

function unwrapData(payload: unknown): unknown {
  let current = payload;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!isRecord(current) || !('data' in current)) return current;
    current = current.data;
  }
  return current;
}

function firstRecord(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (Array.isArray(value)) return value.find(isRecord);
  return undefined;
}

function asRisexArrayPayload(payload: unknown): unknown[] {
  const generic = asArrayPayload(payload);
  if (generic.length > 0) return generic;
  const body = unwrapData(payload);
  if (isRecord(body) && Array.isArray(body.orders)) return body.orders;
  return [];
}

function nestedRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function removeUndefined<T extends Record<string, unknown>>(record: T): T {
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) delete record[key];
  }
  return record;
}

function selectorHash(value: string): Uint8Array { return keccakBytes(new TextEncoder().encode(value)); }
function typeHash(value: string): Uint8Array { return selectorHash(value); }
function hashString(value: string): Uint8Array { return keccakBytes(new TextEncoder().encode(value)); }
function keccakBytes(value: Uint8Array): Uint8Array { return keccak_256(value); }

function abiWord(value: number | bigint): Uint8Array {
  const bigint = BigInt(value);
  if (bigint < 0n) throw new Error('Cannot ABI-encode negative unsigned integer');
  return bigintToBytes(bigint, 32);
}

function bytes32Word(value: Uint8Array): Uint8Array {
  if (value.length !== 32) throw new Error('Expected bytes32 value');
  return value;
}

function addressWord(value: string): Uint8Array {
  return concatBytes(new Uint8Array(12), hexToBytes(normalizeAddress(value).slice(2)));
}

function bigintToBytes(value: bigint, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let current = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    bytes[index] = Number(current & 0xffn);
    current >>= 8n;
  }
  if (current !== 0n) throw new Error(`Value ${value} does not fit in ${length} bytes`);
  return bytes;
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (normalized.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(normalized)) throw new Error('Invalid hex string');
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function normalizePrivateKey(privateKey: string): string {
  const value = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new Error('RISEX_SESSION_SIGNER_PRIVATE_KEY must be a 32-byte hex private key');
  return value;
}

function privateKeyToAddress(privateKey: string): string {
  const publicKey = secp256k1.getPublicKey(hexToBytes(normalizePrivateKey(privateKey)), false);
  return `0x${bytesToHex(keccakBytes(publicKey.slice(1)).slice(-20))}`;
}

function normalizeAddress(address: string): string {
  const value = address.startsWith('0x') ? address.slice(2) : address;
  if (!/^[0-9a-fA-F]{40}$/.test(value)) throw new Error(`Invalid Ethereum address: ${address}`);
  return `0x${value.toLowerCase()}`;
}

function normalizeHex(value: string): string {
  return value.startsWith('0x') ? `0x${value.slice(2).toLowerCase()}` : value.toLowerCase();
}

function assertUint(value: number | bigint, bits: number, label: string): void {
  const bigint = BigInt(value);
  const max = (1n << BigInt(bits)) - 1n;
  if (bigint < 0n || bigint > max) throw new Error(`${label} must fit uint${bits}`);
}

function normalizeClientOrderId(clientOrderId: string | undefined, account: string): string | undefined {
  if (!clientOrderId) return undefined;
  if (/^\d+$/.test(clientOrderId)) return clientOrderId;
  return createNonce(account);
}

function normalizeSignedDecimal(value: string): string {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error(`Invalid decimal quantity: ${value}`);
  return trimmed;
}

function roundDecimalToStepString(value: string, step: string, rounding: 'down' | 'up'): string {
  const units = decimalToIntegerUnits(value, step, 'RISEx price', rounding === 'down' ? 'floor' : 'ceil');
  return formatUnitsToDecimal(units, step);
}

function deriveTpslLimitPrice(stopPrice: string, step: string, type: ExecutionOrderRequest['type'], side: ExecutionOrderRequest['side']): string {
  const stopUnits = decimalToIntegerUnits(stopPrice, step, 'RISEx TPSL stop price');
  const direction = type === 'stop-market'
    ? (side === 'sell' ? -1n : 1n)
    : (side === 'sell' ? 1n : -1n);
  const limitUnits = stopUnits + direction;
  if (limitUnits <= 0n) throw new Error('Derived RISEx TPSL limit price must stay positive');
  return formatUnitsToDecimal(limitUnits, step);
}

function formatUnitsToDecimal(units: bigint, step: string): string {
  const { scale } = parseDecimalParts(step);
  if (scale === 0) return units.toString();
  const factor = 10n ** BigInt(scale);
  const whole = units / factor;
  const fractional = (units % factor).toString().padStart(scale, '0').replace(/0+$/, '');
  return fractional ? `${whole}.${fractional}` : whole.toString();
}
