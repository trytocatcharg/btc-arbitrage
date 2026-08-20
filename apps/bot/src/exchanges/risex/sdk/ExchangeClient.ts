import { InfoClient } from './InfoClient.js';
import { createPermitParams } from './signing/permit.js';
import { createRegisterSignerSignatures } from './signing/signer.js';
import { signCancelTpsl, signPermitSingle, signPlaceTpsl } from './signing/tpsl.js';
import { encodeCancelAll, encodeCancelOrder, encodeIsolatedMargin, encodeLeverage, encodeMarginMode, encodeOrder } from './signing/encoder.js';
import { privateKeyToAddress } from './signing/helpers.js';
import { MarginMode, Side, StopPriceOption, TimeInForce, TpSlStopType } from './types/common.js';
import type { NonceState, PermitParams, RegisterSignerResult } from './types/auth.js';
import type { ExchangeClientOptions, Eip712Domain, PermitSingleApprovalResult } from './types/config.js';
import type { CancelAllResponse, CancelParams, CancelResponse, OpenOrder, OrderParams, OrderResponse, TpSlParams, TpslOrder } from './types/order.js';

interface RisexSdkHttpClient {
  get(path: string, query?: Record<string, string | undefined>): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
}

const MAX_UINT96 = (1n << 96n) - 1n;
const MAX_NONCE_BITMAP_INDEX = 207;
const APPROVE_SINGLE_NONCE_RETRY_COUNT = 8;

export class ExchangeClient {
  public readonly info: InfoClient;
  public readonly account: string;
  public readonly signer: string;

  private readonly accountPrivateKey?: string;
  private readonly signerPrivateKey: string;
  private readonly isErc1271: boolean;
  private domain!: Eip712Domain;
  private target!: string;
  private initialized = false;

  constructor(opts: ExchangeClientOptions, http?: RisexSdkHttpClient) {
    if (!opts.account && !opts.accountKey) throw new Error('Either account or accountKey must be provided.');
    this.info = new InfoClient(opts, http);
    this.signerPrivateKey = opts.signerKey;
    this.signer = privateKeyToAddress(opts.signerKey);
    this.accountPrivateKey = opts.accountKey;
    this.account = opts.account ?? privateKeyToAddress(opts.accountKey!);
    this.isErc1271 = opts.erc1271 ?? false;
  }

  async init(): Promise<this> {
    this.domain = await this.info.getEip712Domain();
    const config = await this.info.getSystemConfig();
    this.target = config.addresses?.router ?? config.addresses?.perp_v2?.orders_manager ?? config.contract_addresses?.perps_manager ?? '';
    if (!this.target) throw new Error('Could not find router/orders_manager in RISEx system config');
    this.initialized = true;
    return this;
  }

  async getNonceState(): Promise<NonceState> {
    return this.info.getNonceState(this.account);
  }

  async isSignerRegistered(): Promise<boolean> {
    const res = await this.info.getSessionKeyStatus(this.account, this.signer);
    return res.status === 1;
  }

  async registerSigner(label = 'btc-arbitrage'): Promise<RegisterSignerResult> {
    this.assertInit();
    this.assertAccountKey();
    if (await this.isSignerRegistered()) return { alreadyActive: true };
    const nonceState = await this.getNonceState();
    const sigs = await createRegisterSignerSignatures(this.accountPrivateKey!, this.account, this.signerPrivateKey, this.signer, this.domain, nonceState);
    return await this.info.http.post('/v1/auth/register-signer', {
      account: this.account,
      signer: this.signer,
      message: sigs.message,
      nonce_anchor: String(sigs.nonceAnchor),
      nonce_bitmap_index: sigs.nonceBitmapIndex,
      expiration: String(sigs.expiration),
      account_signature: sigs.accountSignature,
      signer_signature: sigs.signerSignature,
      label
    }) as RegisterSignerResult;
  }

  async revokeSigner(signerAddress?: string): Promise<unknown> {
    this.assertInit();
    this.assertAccountKey();
    const nonceState = await this.getNonceState();
    const sigs = await createRegisterSignerSignatures(this.accountPrivateKey!, this.account, this.signerPrivateKey, this.signer, this.domain, nonceState);
    return this.info.http.post('/v1/auth/revoke-signer', {
      account: this.account,
      signer: signerAddress ?? this.signer,
      nonce_anchor: String(sigs.nonceAnchor),
      nonce_bitmap_index: sigs.nonceBitmapIndex,
      account_signature: sigs.accountSignature,
      signer_signature: sigs.signerSignature
    });
  }

  async approvePermitSingleBudget(budget = MAX_UINT96, expirySeconds = 365 * 24 * 3600): Promise<PermitSingleApprovalResult> {
    this.assertInit();
    this.assertAccountKey();
    const config = await this.info.getSystemConfig();
    const operator = config.addresses?.operator_hub;
    if (typeof operator !== 'string' || !operator) throw new Error('No operator_hub found in RISEx system config');
    const nonceState = await this.getNonceState();
    const allowanceExpiry = Math.floor(Date.now() / 1000) + expirySeconds;
    const baseAnchor = Number(nonceState.nonce_anchor);
    const baseBitmap = nonceState.current_bitmap_index;

    let lastError: unknown;
    for (let attempt = 0; attempt < APPROVE_SINGLE_NONCE_RETRY_COUNT; attempt += 1) {
      const { anchor, bitmap } = advancePermitSingleNonce(baseAnchor, baseBitmap, attempt);
      const signature = signPermitSingle({
        privateKey: this.accountPrivateKey!,
        domain: this.domain,
        account: this.account,
        operator,
        budget,
        allowanceExpiry,
        nonceAnchor: anchor,
        nonceBitmap: bitmap
      });

      try {
        return await this.info.http.post('/v1/auth/approve-single', {
          account: this.account,
          operator,
          budget: String(budget),
          allowance_expiry: allowanceExpiry,
          nonce_anchor: String(anchor),
          nonce_bitmap_index: bitmap,
          signature
        }) as PermitSingleApprovalResult;
      } catch (error) {
        lastError = error;
        if (!isNonceUsedError(error) || attempt === APPROVE_SINGLE_NONCE_RETRY_COUNT - 1) throw error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error('RISEx approve-single failed after nonce retries');
  }

  async placeOrder(orderParams: OrderParams): Promise<OrderResponse> {
    const hash = encodeOrder(orderParams, this.isErc1271);
    const permit = await this.createPermit(hash, orderParams.nonce);
    return await this.info.http.post('/v1/orders/place', {
      market_id: orderParams.market_id,
      side: orderParams.side,
      order_type: orderParams.order_type,
      price_ticks: orderParams.price_ticks,
      size_steps: orderParams.size_steps,
      time_in_force: orderParams.time_in_force,
      post_only: orderParams.post_only,
      reduce_only: orderParams.reduce_only,
      stp_mode: orderParams.stp_mode,
      ttl_units: orderParams.ttl_units,
      client_order_id: orderParams.client_order_id ?? '0',
      builder_id: orderParams.builder_id ?? 0,
      permit
    }) as OrderResponse;
  }

  async cancelOrder(params: CancelParams): Promise<CancelResponse> {
    let restingOrderId = params.resting_order_id;
    if (restingOrderId == null) {
      const openOrders = await this.info.getOpenOrders(this.account, params.market_id);
      const match = openOrders.find((order) => order.order_id === params.order_id) as OpenOrder | undefined;
      if (!match?.resting_order_id) throw new Error(`Could not find resting_order_id for order ${params.order_id}`);
      restingOrderId = match.resting_order_id;
    }
    const hash = encodeCancelOrder({ ...params, resting_order_id: restingOrderId });
    const permit = await this.createPermit(hash, params.nonce);
    return await this.info.http.post('/v1/orders/cancel', {
      market_id: params.market_id,
      order_id: params.order_id,
      permit
    }) as CancelResponse;
  }

  async cancelAllOrders(marketId = 0, nonce?: NonceState): Promise<CancelAllResponse> {
    const hash = encodeCancelAll(marketId);
    const permit = await this.createPermit(hash, nonce);
    return await this.info.http.post('/v1/orders/cancel-all', {
      market_id: marketId,
      permit
    }) as CancelAllResponse;
  }

  async updateLeverage(marketId: number, leverage: bigint, nonce?: NonceState): Promise<unknown> {
    const hash = encodeLeverage(marketId, leverage);
    const permit = await this.createPermit(hash, nonce);
    return this.info.http.post('/v1/account/leverage', {
      market_id: marketId,
      leverage: String(leverage),
      permit_params: permit
    });
  }

  async updateMarginMode(marketId: number, mode: MarginMode, nonce?: NonceState): Promise<unknown> {
    const hash = encodeMarginMode(marketId, mode);
    const permit = await this.createPermit(hash, nonce);
    return this.info.http.post('/v1/account/margin-mode', {
      market_id: marketId,
      margin_mode: mode,
      permit_params: permit
    });
  }

  async updateIsolatedMargin(marketId: number, amount: bigint, nonce?: NonceState): Promise<unknown> {
    const hash = encodeIsolatedMargin(marketId, amount);
    const permit = await this.createPermit(hash, nonce);
    return this.info.http.post('/v1/account/isolated-margin', {
      market_id: marketId,
      amount: String(amount),
      permit_params: permit
    });
  }

  async placeStopLoss(params: TpSlParams): Promise<Record<string, unknown>> {
    return this.placeTpsl(params, TpSlStopType.StopLoss);
  }

  async placeTakeProfit(params: TpSlParams): Promise<Record<string, unknown>> {
    return this.placeTpsl(params, TpSlStopType.TakeProfit);
  }

  async cancelTpslOrder(orderId: string): Promise<Record<string, unknown>> {
    this.assertInit();
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const signature = signCancelTpsl({
      privateKey: this.signerPrivateKey,
      domain: this.domain,
      account: this.account,
      orderId,
      deadline
    });
    return await this.info.http.post('/v1/orders/tpsl/cancel', {
      order_id: orderId,
      account: this.account,
      signer: this.signer,
      signature,
      deadline
    }) as Record<string, unknown>;
  }

  async getOpenTpslOrders(): Promise<TpslOrder[]> {
    const payload = await this.info.http.get('/v1/orders/tpsl', {
      account: this.account,
      statuses: 'TPSL_ORDER_STATUS_ACCEPTED'
    });
    const body = unwrapData(payload);
    if (Array.isArray(body)) return body.filter(isRecord) as TpslOrder[];
    if (isRecord(body) && Array.isArray(body.orders)) return body.orders.filter(isRecord) as TpslOrder[];
    return [];
  }

  private async createPermit(hash: string, nonce?: NonceState): Promise<PermitParams> {
    this.assertInit();
    const nonceState = nonce ?? await this.getNonceState();
    return createPermitParams(hash, this.signerPrivateKey, this.signer, this.account, this.target, this.domain, nonceState, undefined, this.isErc1271);
  }

  private assertInit(): void {
    if (!this.initialized) throw new Error('ExchangeClient not initialized. Call init() first.');
  }

  private assertAccountKey(): void {
    if (!this.accountPrivateKey) throw new Error('accountKey is required for this operation.');
  }

  private async placeTpsl(params: TpSlParams, stopType: TpSlStopType): Promise<Record<string, unknown>> {
    this.assertInit();
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const stopPriceOption = params.stop_price_option ?? StopPriceOption.LastTradedPrice;
    const tif = params.tif ?? TimeInForce.GoodTillCancelled;
    const signature = signPlaceTpsl({
      privateKey: this.signerPrivateKey,
      domain: this.domain,
      account: this.account,
      marketId: params.market_id,
      side: params.side,
      size: params.size,
      stopType,
      stopPrice: params.stop_price,
      limitPrice: params.limit_price,
      orderType: 1,
      stopPriceOption,
      tif,
      deadline
    });
    return await this.info.http.post('/v1/orders/tpsl', {
      account: this.account,
      market_id: String(params.market_id),
      side: params.side,
      size: params.size,
      stop_type: stopType === TpSlStopType.TakeProfit ? 'TAKE_PROFIT' : 'STOP_LOSS',
      order_type: 1,
      stop_price: params.stop_price,
      limit_price: params.limit_price,
      stop_price_option: stopPriceOption === StopPriceOption.MarkPrice ? 'MARK_PRICE' : 'LAST_TRADED_PRICE',
      tif,
      signer: this.signer,
      signature,
      deadline
    }) as Record<string, unknown>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function advancePermitSingleNonce(anchor: number, bitmap: number, steps: number): { anchor: number; bitmap: number } {
  let nextAnchor = anchor;
  let nextBitmap = bitmap + steps;
  while (nextBitmap > MAX_NONCE_BITMAP_INDEX) {
    nextAnchor += 1;
    nextBitmap -= MAX_NONCE_BITMAP_INDEX + 1;
  }
  return { anchor: nextAnchor, bitmap: nextBitmap };
}

function isNonceUsedError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('NonceUsed(');
}
