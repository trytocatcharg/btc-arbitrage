import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import wasmInit, { get_order_msg as wasmGetOrderMsgHash, sign_message as wasmSignMessage } from '@x10xchange/stark-crypto-wrapper-wasm';
import { ec as starkEc, hash as starkHash, selector as starkSelector, shortString as starkShortString } from 'starknet';

export type ExtendedOrderSide = 'BUY' | 'SELL';
export type ExtendedOrderType = 'LIMIT' | 'MARKET' | 'TPSL';
export type ExtendedOrderTimeInForce = 'GTT' | 'IOC';
export type ExtendedOrderTpSlType = 'ORDER' | 'POSITION';
export type ExtendedOrderTriggerPriceType = 'MARK' | 'INDEX' | 'LAST';
export type ExtendedOrderPriceType = 'LIMIT' | 'MARKET';
export type HexString = `0x${string}`;

export interface ExtendedStarknetDomain {
  name: string;
  version: string;
  chainId: string;
  revision: number;
}

export interface ExtendedSigningMarket {
  name: string;
  l2Config: {
    collateralId: string;
    collateralResolution: string | number;
    syntheticId: string;
    syntheticResolution: string | number;
  };
  tradingConfig: {
    minOrderSizeChange: string | number;
    maxPositionValue: string | number;
  };
}

export interface ExtendedFees {
  makerFeeRate: string | number;
  takerFeeRate: string | number;
  builderFeeRate?: string | number;
}

export interface ExtendedOrderContext {
  assetIdCollateral: string;
  assetIdSynthetic: string;
  settlementResolutionCollateral: string;
  settlementResolutionSynthetic: string;
  minOrderSizeChange: string;
  maxPositionValue: string;
  feeRate: string;
  vaultId: string;
  starkPrivateKey: HexString;
  starknetDomain: ExtendedStarknetDomain;
  builderId?: string;
  builderFee?: string;
}

export interface ExtendedTpSlTriggerInput {
  triggerPrice: string | number;
  triggerPriceType: ExtendedOrderTriggerPriceType;
  price: string | number;
  priceType: ExtendedOrderPriceType;
}

export interface CreateExtendedSignedOrderInput {
  marketName: string;
  orderType: ExtendedOrderType;
  side: ExtendedOrderSide;
  amountOfSynthetic: string | number;
  price: string | number;
  timeInForce: ExtendedOrderTimeInForce;
  reduceOnly?: boolean;
  postOnly?: boolean;
  tpSlType?: ExtendedOrderTpSlType;
  takeProfit?: ExtendedTpSlTriggerInput;
  stopLoss?: ExtendedTpSlTriggerInput;
  cancelId?: string;
  ctx: ExtendedOrderContext;
  expiryTime?: Date;
  now?: Date;
  nonce?: number;
}

export interface ExtendedSignedOrderJson {
  id: string;
  market: string;
  type: ExtendedOrderType;
  side: ExtendedOrderSide;
  qty: string;
  price: string;
  timeInForce: ExtendedOrderTimeInForce;
  expiryEpochMillis: number;
  fee: string;
  nonce: string;
  settlement?: ExtendedOrderSettlementJson;
  reduceOnly?: boolean;
  postOnly?: boolean;
  tpSlType?: ExtendedOrderTpSlType;
  takeProfit?: ExtendedOrderTpSlTriggerJson;
  stopLoss?: ExtendedOrderTpSlTriggerJson;
  cancelId?: string;
  builderId?: string;
  builderFee?: string;
  debuggingAmounts: ExtendedOrderDebuggingAmounts;
}

export interface ExtendedOrderSettlementJson {
  signature: { r: HexString; s: HexString };
  starkKey: HexString;
  collateralPosition: string;
}

export interface ExtendedOrderTpSlTriggerJson {
  triggerPrice: string;
  triggerPriceType: ExtendedOrderTriggerPriceType;
  price: string;
  priceType: ExtendedOrderPriceType;
  settlement: ExtendedOrderSettlementJson;
  debuggingAmounts: ExtendedOrderDebuggingAmounts;
}

export interface ExtendedOrderDebuggingAmounts {
  collateralAmount: string;
  feeAmount: string;
  syntheticAmount: string;
}

const ORDER_EXPIRATION_MILLIS = 60 * 60 * 1000;
const STARKNET_SETTLEMENT_BUFFER_SECONDS = 14 * 24 * 60 * 60;
const MILLIS_IN_SECOND = 1000;
const MAX_NONCE_EXCLUSIVE = 2 ** 31;

let wasmInitPromise: Promise<void> | undefined;

export async function initExtendedSigningWasm(): Promise<void> {
  wasmInitPromise ??= (async () => {
    try {
      const wasmDir = dirname(createRequire(import.meta.url).resolve('@x10xchange/stark-crypto-wrapper-wasm'));
      const wasmBuffer = readFileSync(join(wasmDir, 'stark_crypto_wrapper_wasm_bg.wasm'));
      await wasmInit({ module_or_path: wasmBuffer });
    } catch {
      // The signing functions have Starknet JS fallbacks; do not log from the adapter.
    }
  })();
  await wasmInitPromise;
}

export function createExtendedOrderContext(input: {
  market: ExtendedSigningMarket;
  fees: ExtendedFees;
  starknetDomain: ExtendedStarknetDomain;
  vaultId: string;
  starkPrivateKey: string;
  builderId?: string | number;
  builderFee?: string | number;
}): ExtendedOrderContext {
  assertHexString(input.starkPrivateKey, 'EXTENDED_STARK_PRIVATE_KEY');
  return {
    assetIdCollateral: canonicalAssetId(input.market.l2Config.collateralId),
    assetIdSynthetic: canonicalAssetId(input.market.l2Config.syntheticId),
    settlementResolutionCollateral: normalizeDecimal(input.market.l2Config.collateralResolution),
    settlementResolutionSynthetic: normalizeDecimal(input.market.l2Config.syntheticResolution),
    minOrderSizeChange: normalizeDecimal(input.market.tradingConfig.minOrderSizeChange),
    maxPositionValue: normalizeDecimal(input.market.tradingConfig.maxPositionValue),
    feeRate: maxDecimal(normalizeDecimal(input.fees.makerFeeRate), normalizeDecimal(input.fees.takerFeeRate)),
    vaultId: normalizeIntegerString(input.vaultId, 'EXTENDED_VAULT_ID'),
    starkPrivateKey: input.starkPrivateKey as HexString,
    starknetDomain: input.starknetDomain,
    builderId: input.builderId === undefined ? undefined : normalizeIntegerString(input.builderId, 'builderId'),
    builderFee: input.builderFee === undefined ? undefined : normalizeDecimal(input.builderFee)
  };
}

export function createExtendedSignedOrder(input: CreateExtendedSignedOrderInput): ExtendedSignedOrderJson {
  const expiryEpochMillis = (input.expiryTime ?? new Date((input.now ?? new Date()).getTime() + ORDER_EXPIRATION_MILLIS)).getTime();
  const nonce = String(input.nonce ?? generateExtendedNonce());
  const amountOfSynthetic = normalizeDecimal(input.amountOfSynthetic);
  const price = normalizeDecimal(input.price);
  const totalFeeRate = input.ctx.builderFee ? addDecimal(input.ctx.feeRate, input.ctx.builderFee) : input.ctx.feeRate;
  const tpSlSide = input.orderType === 'TPSL' ? input.side : getOppositeOrderSide(input.side);
  const takeProfitAmount = input.takeProfit && input.tpSlType === 'POSITION'
    ? calcEntirePositionSize(normalizeDecimal(input.takeProfit.price), input.ctx.minOrderSizeChange, input.ctx.maxPositionValue)
    : amountOfSynthetic;
  const stopLossAmount = input.stopLoss && input.tpSlType === 'POSITION'
    ? calcEntirePositionSize(normalizeDecimal(input.stopLoss.price), input.ctx.minOrderSizeChange, input.ctx.maxPositionValue)
    : amountOfSynthetic;
  const takeProfitParams = input.takeProfit ? getCreateOrderParams({ side: tpSlSide, amountOfSynthetic: takeProfitAmount, price: normalizeDecimal(input.takeProfit.price), expiryEpochMillis, nonce, totalFeeRate, ctx: input.ctx }) : undefined;
  const stopLossParams = input.stopLoss ? getCreateOrderParams({ side: tpSlSide, amountOfSynthetic: stopLossAmount, price: normalizeDecimal(input.stopLoss.price), expiryEpochMillis, nonce, totalFeeRate, ctx: input.ctx }) : undefined;
  const createOrderParams = getCreateOrderParams({ side: input.side, amountOfSynthetic, price, expiryEpochMillis, nonce, totalFeeRate, ctx: input.ctx });

  return omitUndefined({
    id: hexToDecimal(createOrderParams.orderHash),
    market: input.marketName,
    type: input.orderType,
    side: input.side,
    qty: amountOfSynthetic,
    price,
    timeInForce: input.timeInForce,
    expiryEpochMillis,
    fee: totalFeeRate,
    nonce,
    settlement: input.orderType !== 'TPSL' ? createSettlement(input.ctx.vaultId, createOrderParams.orderSignature) : undefined,
    reduceOnly: input.reduceOnly,
    postOnly: input.postOnly,
    tpSlType: input.tpSlType,
    takeProfit: input.takeProfit && takeProfitParams ? createTrigger(input.ctx.vaultId, input.takeProfit, takeProfitParams) : undefined,
    stopLoss: input.stopLoss && stopLossParams ? createTrigger(input.ctx.vaultId, input.stopLoss, stopLossParams) : undefined,
    cancelId: input.cancelId,
    builderId: input.ctx.builderId,
    builderFee: input.ctx.builderFee,
    debuggingAmounts: createOrderParams.debuggingAmounts
  }) as ExtendedSignedOrderJson;
}

export function generateExtendedNonce(): number {
  return randomInt(1, MAX_NONCE_EXCLUSIVE);
}

export function roundDecimalToStep(value: string | number, step: string | number, rounding: 'up' | 'down' = 'down'): string {
  const valueRatio = toRatio(value);
  const stepRatio = toRatio(step);
  if (stepRatio.numerator <= 0n) throw new Error('Step must be greater than 0');
  const quotientNumerator = valueRatio.numerator * stepRatio.denominator;
  const quotientDenominator = valueRatio.denominator * stepRatio.numerator;
  const quotient = divRound(quotientNumerator, quotientDenominator, rounding);
  return formatRatio(quotient * stepRatio.numerator, stepRatio.denominator);
}

export function applyBasisPoints(value: string | number, basisPoints: number): string {
  const ratio = toRatio(value);
  return formatRatio(ratio.numerator * BigInt(basisPoints), ratio.denominator * 10_000n);
}

function getCreateOrderParams(input: {
  side: ExtendedOrderSide;
  amountOfSynthetic: string;
  price: string;
  expiryEpochMillis: number;
  nonce: string;
  totalFeeRate: string;
  ctx: ExtendedOrderContext;
}) {
  const rounding = input.side === 'BUY' ? 'up' : 'down';
  const collateralAmountStark = multiplyDecimalsToInteger([input.amountOfSynthetic, input.price, input.ctx.settlementResolutionCollateral], rounding);
  const feeStark = multiplyDecimalsToInteger([input.amountOfSynthetic, input.price, input.totalFeeRate, input.ctx.settlementResolutionCollateral], 'up');
  const syntheticAmountStark = multiplyDecimalsToInteger([input.amountOfSynthetic, input.ctx.settlementResolutionSynthetic], rounding);
  const orderHash = getStarknetOrderMsgHash({
    side: input.side,
    nonce: input.nonce,
    assetIdCollateral: input.ctx.assetIdCollateral,
    assetIdSynthetic: input.ctx.assetIdSynthetic,
    collateralAmountStark,
    feeStark,
    syntheticAmountStark,
    expiryEpochMillis: input.expiryEpochMillis,
    vaultId: input.ctx.vaultId,
    starkPublicKey: getStarkPublicKey(input.ctx.starkPrivateKey),
    starknetDomain: input.ctx.starknetDomain
  });
  const orderSignature = signMessage(orderHash, input.ctx.starkPrivateKey);
  return {
    orderHash,
    orderSignature,
    debuggingAmounts: {
      collateralAmount: collateralAmountStark.toString(10),
      feeAmount: feeStark.toString(10),
      syntheticAmount: syntheticAmountStark.toString(10)
    }
  };
}

function getStarknetOrderMsgHash(input: {
  side: ExtendedOrderSide;
  nonce: string;
  assetIdCollateral: string;
  assetIdSynthetic: string;
  collateralAmountStark: bigint;
  feeStark: bigint;
  syntheticAmountStark: bigint;
  expiryEpochMillis: number;
  vaultId: string;
  starkPublicKey: HexString;
  starknetDomain: ExtendedStarknetDomain;
}): string {
  const isBuyingSynthetic = input.side === 'BUY';
  const expirationTimestamp = Math.ceil(input.expiryEpochMillis / MILLIS_IN_SECOND) + STARKNET_SETTLEMENT_BUFFER_SECONDS;
  const amountCollateral = isBuyingSynthetic ? -input.collateralAmountStark : input.collateralAmountStark;
  const amountSynthetic = isBuyingSynthetic ? input.syntheticAmountStark : -input.syntheticAmountStark;
  const args = [
    input.vaultId,
    canonicalAssetId(input.assetIdSynthetic),
    amountSynthetic.toString(10),
    canonicalAssetId(input.assetIdCollateral),
    amountCollateral.toString(10),
    canonicalAssetId(input.assetIdCollateral),
    input.feeStark.toString(10),
    expirationTimestamp.toString(10),
    input.nonce,
    input.starkPublicKey,
    input.starknetDomain.name,
    input.starknetDomain.version,
    input.starknetDomain.chainId,
    input.starknetDomain.revision.toString()
  ] as const;

  try {
    return stripHex(wasmGetOrderMsgHash(...args) as HexString);
  } catch {
    return stripHex(jsGetOrderMsgHash(...args));
  }
}

function jsGetOrderMsgHash(...args: Parameters<typeof wasmGetOrderMsgHash>): HexString {
  const [positionId, baseAssetIdHex, baseAmount, quoteAssetIdHex, quoteAmount, feeAssetIdHex, feeAmount, expiration, salt, userPublicKeyHex, domainName, domainVersion, domainChainId, domainRevision] = args;
  const domainHash = jsGetStarknetDomainObjHash({ name: domainName, version: domainVersion, chainId: domainChainId, revision: Number(domainRevision) });
  const orderSelector = starkSelector.getSelector('"Order"("position_id":"felt","base_asset_id":"AssetId","base_amount":"i64","quote_asset_id":"AssetId","quote_amount":"i64","fee_asset_id":"AssetId","fee_amount":"u64","expiration":"Timestamp","salt":"felt")"PositionId"("value":"u32")"AssetId"("value":"felt")"Timestamp"("seconds":"u64")');
  const orderHash = starkHash.computePoseidonHashOnElements([orderSelector, positionId, baseAssetIdHex, baseAmount, quoteAssetIdHex, quoteAmount, feeAssetIdHex, feeAmount, expiration, salt]);
  return jsGetObjMsgHash(domainHash, userPublicKeyHex, orderHash);
}

function jsGetObjMsgHash(domainHash: string, publicKey: string, objHash: string): HexString {
  const messageFelt = starkShortString.encodeShortString('StarkNet Message');
  return canonicalHex(starkHash.computePoseidonHashOnElements([messageFelt, domainHash, publicKey, objHash]));
}

function jsGetStarknetDomainObjHash(domain: ExtendedStarknetDomain): HexString {
  const domainSelector = starkSelector.getSelector('"StarknetDomain"("name":"shortstring","version":"shortstring","chainId":"shortstring","revision":"shortstring")');
  return canonicalHex(starkHash.computePoseidonHashOnElements([
    domainSelector,
    starkShortString.encodeShortString(domain.name),
    starkShortString.encodeShortString(domain.version),
    starkShortString.encodeShortString(domain.chainId),
    domain.revision.toString()
  ]));
}

function signMessage(messageHash: string, starkPrivateKey: HexString): { signature: { r: HexString; s: HexString }; starkKey: HexString } {
  const starkKey = getStarkPublicKey(starkPrivateKey);
  try {
    const signature = wasmSignMessage(starkPrivateKey, messageHash);
    const result = { signature: { r: canonicalHex(signature.r), s: canonicalHex(signature.s) }, starkKey };
    signature.free();
    return result;
  } catch {
    const signature = starkEc.starkCurve.sign(messageHash, starkPrivateKey);
    return { signature: { r: canonicalHex(signature.r.toString(16)), s: canonicalHex(signature.s.toString(16)) }, starkKey };
  }
}

function getStarkPublicKey(privateKey: HexString): HexString {
  return canonicalHex(starkEc.starkCurve.getStarkKey(privateKey));
}

function createSettlement(vaultId: string, signature: { signature: { r: HexString; s: HexString }; starkKey: HexString }): ExtendedOrderSettlementJson {
  return { signature: signature.signature, starkKey: signature.starkKey, collateralPosition: vaultId };
}

function createTrigger(vaultId: string, trigger: ExtendedTpSlTriggerInput, params: ReturnType<typeof getCreateOrderParams>): ExtendedOrderTpSlTriggerJson {
  return {
    triggerPrice: normalizeDecimal(trigger.triggerPrice),
    triggerPriceType: trigger.triggerPriceType,
    price: normalizeDecimal(trigger.price),
    priceType: trigger.priceType,
    settlement: createSettlement(vaultId, params.orderSignature),
    debuggingAmounts: params.debuggingAmounts
  };
}

function calcEntirePositionSize(price: string, minOrderSizeChange: string, maxPositionValue: string): string {
  if (compareDecimal(price, '0') <= 0) throw new Error('TPSL price must be greater than 0');
  const raw = formatRatio(toRatio(maxPositionValue).numerator * 50n * toRatio(price).denominator, toRatio(maxPositionValue).denominator * toRatio(price).numerator);
  return roundDecimalToStep(raw, minOrderSizeChange, 'down');
}

function getOppositeOrderSide(side: ExtendedOrderSide): ExtendedOrderSide {
  return side === 'BUY' ? 'SELL' : 'BUY';
}

function multiplyDecimalsToInteger(values: Array<string | number>, rounding: 'up' | 'down'): bigint {
  let numerator = 1n;
  let denominator = 1n;
  for (const value of values) {
    const ratio = toRatio(value);
    numerator *= ratio.numerator;
    denominator *= ratio.denominator;
  }
  return divRound(numerator, denominator, rounding);
}

function addDecimal(a: string, b: string): string {
  const left = toRatio(a);
  const right = toRatio(b);
  return formatRatio(left.numerator * right.denominator + right.numerator * left.denominator, left.denominator * right.denominator);
}

function maxDecimal(a: string, b: string): string {
  return compareDecimal(a, b) >= 0 ? a : b;
}

function compareDecimal(a: string | number, b: string | number): number {
  const left = toRatio(a);
  const right = toRatio(b);
  const diff = left.numerator * right.denominator - right.numerator * left.denominator;
  return diff === 0n ? 0 : diff > 0n ? 1 : -1;
}

function toRatio(value: string | number): { numerator: bigint; denominator: bigint } {
  const normalized = normalizeDecimal(value);
  const negative = normalized.startsWith('-');
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [integerPart, fractionalPart = ''] = unsigned.split('.');
  const denominator = 10n ** BigInt(fractionalPart.length);
  const numerator = BigInt(`${integerPart}${fractionalPart}` || '0') * (negative ? -1n : 1n);
  return { numerator, denominator };
}

function divRound(numerator: bigint, denominator: bigint, rounding: 'up' | 'down'): bigint {
  if (denominator <= 0n) throw new Error('Denominator must be positive');
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;
  if (rounding === 'up' && numerator > 0n) return quotient + 1n;
  if (rounding === 'up' && numerator < 0n) return quotient;
  return quotient;
}


function formatRatio(numerator: bigint, denominator: bigint): string {
  if (denominator <= 0n) throw new Error('Denominator must be positive');
  const negative = numerator < 0n;
  let remainder = negative ? -numerator : numerator;
  const integer = remainder / denominator;
  remainder %= denominator;
  if (remainder === 0n) return `${negative ? '-' : ''}${integer.toString(10)}`;
  let fraction = '';
  let guard = 0;
  while (remainder !== 0n && guard < 40) {
    remainder *= 10n;
    fraction += (remainder / denominator).toString(10);
    remainder %= denominator;
    guard += 1;
  }
  return normalizeDecimal(`${negative ? '-' : ''}${integer.toString(10)}.${fraction}`);
}

function normalizeDecimal(value: string | number): string {
  const raw = String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(raw)) throw new Error(`Invalid decimal: ${raw}`);
  const negative = raw.startsWith('-');
  const unsigned = negative ? raw.slice(1) : raw;
  const [integerRaw, fractionRaw = ''] = unsigned.split('.');
  const integerPart = integerRaw.replace(/^0+(?=\d)/, '') || '0';
  const fractionPart = fractionRaw.replace(/0+$/, '');
  const normalized = fractionPart ? `${integerPart}.${fractionPart}` : integerPart;
  return negative && normalized !== '0' ? `-${normalized}` : normalized;
}

function normalizeIntegerString(value: string | number, fieldName: string): string {
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${fieldName} must be an integer string`);
  return BigInt(raw).toString(10);
}

function canonicalAssetId(value: string): HexString {
  if (value.startsWith('0x')) return canonicalHex(value);
  if (/^\d+$/.test(value)) return canonicalHex(BigInt(value).toString(16));
  throw new Error('Extended asset id must be a hex or integer string');
}

function assertHexString(value: string, fieldName: string): asserts value is HexString {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) throw new Error(`${fieldName} must be a hex string`);
}

function canonicalHex(value: string): HexString {
  const raw = value.startsWith('0x') ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]+$/.test(raw)) throw new Error(`Invalid hex string: ${value}`);
  return `0x${BigInt(`0x${raw}`).toString(16)}` as HexString;
}

function stripHex(value: HexString): string {
  return canonicalHex(value).slice(2);
}

function hexToDecimal(value: string): string {
  return BigInt(`0x${value.startsWith('0x') ? value.slice(2) : value}`).toString(10);
}

function omitUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}
