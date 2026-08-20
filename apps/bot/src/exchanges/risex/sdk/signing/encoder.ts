import type { CancelParams, OrderParams } from '../types/order.js';
import { abiSignedWord, abiWord, bytes32Word, concatBytes, hashString, hexToBytes, keccakBytes } from './helpers.js';

const ACTION_PLACE_ORDER = 'RISE_PERPS_PLACE_ORDER_V1';
const ACTION_CANCEL_ORDER = 'RISE_PERPS_CANCEL_ORDER_V1';
const ACTION_CANCEL_ALL_ORDERS = 'RISE_PERPS_CANCEL_ALL_ORDERS_V1';
const ACTION_UPDATE_LEVERAGE = 'RISE_PERPS_UPDATE_LEVERAGE_V1';
const ACTION_UPDATE_MARGIN_MODE = 'RISE_PERPS_UPDATE_MARGIN_MODE_V1';
const ACTION_UPDATE_ISOLATED_MARGIN = 'RISE_PERPS_UPDATE_ISOLATED_MARGIN_V1';

const ACTION_PLACE_ORDER_HASH = hashString(ACTION_PLACE_ORDER);
const ACTION_CANCEL_ORDER_HASH = hashString(ACTION_CANCEL_ORDER);
const ACTION_CANCEL_ALL_ORDERS_HASH = hashString(ACTION_CANCEL_ALL_ORDERS);
const ACTION_UPDATE_LEVERAGE_HASH = hashString(ACTION_UPDATE_LEVERAGE);
const ACTION_UPDATE_MARGIN_MODE_HASH = hashString(ACTION_UPDATE_MARGIN_MODE);
const ACTION_UPDATE_ISOLATED_MARGIN_HASH = hashString(ACTION_UPDATE_ISOLATED_MARGIN);

const V3_FLAG_PERMIT = 0x01;
const V3_FLAG_BUILDER = 0x02;
const V3_FLAG_CLIENT_ID = 0x04;
const V3_FLAG_PERMIT_ERC1271 = 0x09;
const V3_FLAG_TTL = 0x10;

function encodeOrderData(p: OrderParams): bigint {
  let orderFlags = 0;
  if (p.side & 1) orderFlags |= 0x01;
  if (p.post_only) orderFlags |= 0x02;
  if (p.reduce_only) orderFlags |= 0x04;
  orderFlags |= (p.stp_mode & 3) << 3;
  orderFlags |= (p.order_type & 1) << 5;
  orderFlags |= (p.time_in_force & 3) << 6;

  let data = 0n;
  data |= BigInt(p.market_id & 0xffff) << 70n;
  data |= BigInt(p.size_steps & 0xffffffff) << 38n;
  data |= BigInt(p.price_ticks & 0xffffff) << 14n;
  data |= BigInt(orderFlags & 0xff) << 6n;
  data |= 1n << 1n;
  return data;
}

function computeHeaderFlags(builderId: number, clientOrderId: bigint, ttlUnits: number, isErc1271 = false): number {
  let flags = isErc1271 ? V3_FLAG_PERMIT_ERC1271 : V3_FLAG_PERMIT;
  if (builderId !== 0) flags |= V3_FLAG_BUILDER;
  if (clientOrderId !== 0n) flags |= V3_FLAG_CLIENT_ID;
  if (ttlUnits !== 0) flags |= V3_FLAG_TTL;
  return flags;
}

export function encodeOrder(p: OrderParams, isErc1271 = false): string {
  const orderData = encodeOrderData(p);
  const clientOrderId = BigInt(p.client_order_id ?? '0');
  const headerFlags = computeHeaderFlags(p.builder_id ?? 0, clientOrderId, p.ttl_units, isErc1271);
  const encoded = concatBytes(
    bytes32Word(ACTION_PLACE_ORDER_HASH),
    abiWord(headerFlags),
    abiWord(orderData),
    abiWord(p.builder_id ?? 0),
    abiWord(clientOrderId),
    abiWord(p.ttl_units)
  );
  return `0x${Buffer.from(keccakBytes(encoded)).toString('hex')}`;
}

export function encodeCancelOrder(p: CancelParams): string {
  if (p.resting_order_id == null) throw new Error('resting_order_id is required for cancel. Fetch it from getOpenOrders().');
  const encoded = concatBytes(bytes32Word(ACTION_CANCEL_ORDER_HASH), abiWord(BigInt(p.market_id)), abiWord(BigInt(p.resting_order_id)));
  return `0x${Buffer.from(keccakBytes(encoded)).toString('hex')}`;
}

export function encodeCancelAll(marketId: number): string {
  const encoded = concatBytes(bytes32Word(ACTION_CANCEL_ALL_ORDERS_HASH), abiWord(BigInt(marketId)));
  return `0x${Buffer.from(keccakBytes(encoded)).toString('hex')}`;
}

export function encodeLeverage(marketId: number, leverage: bigint): string {
  const encoded = concatBytes(bytes32Word(ACTION_UPDATE_LEVERAGE_HASH), abiWord(BigInt(marketId)), abiWord(leverage));
  return `0x${Buffer.from(keccakBytes(encoded)).toString('hex')}`;
}

export function encodeMarginMode(marketId: number, marginMode: number): string {
  const encoded = concatBytes(bytes32Word(ACTION_UPDATE_MARGIN_MODE_HASH), abiWord(BigInt(marketId)), abiWord(marginMode));
  return `0x${Buffer.from(keccakBytes(encoded)).toString('hex')}`;
}

export function encodeIsolatedMargin(marketId: number, amount: bigint): string {
  const encoded = concatBytes(bytes32Word(ACTION_UPDATE_ISOLATED_MARGIN_HASH), abiWord(BigInt(marketId)), abiSignedWord(amount));
  return `0x${Buffer.from(keccakBytes(encoded)).toString('hex')}`;
}

export function hashHexToBytes32(hash: string): Uint8Array {
  const bytes = hexToBytes(hash);
  if (bytes.length !== 32) throw new Error('Expected 32-byte hash');
  return bytes;
}
