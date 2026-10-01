import { ed25519 } from "@noble/curves/ed25519";

/** Canonical-JSON scalar values. `bigint` exists because Arcus Scheme 1
 * payloads carry nanosecond timestamps (`ct`, `g`) that exceed
 * Number.MAX_SAFE_INTEGER — the serializer must emit them as raw integer
 * literals, never through JSON.stringify on a number. */
export type ArcusPayloadValue = string | number | bigint | boolean;
/** Key-sorted, no-whitespace JSON object; `undefined` values are omitted
 * (e.g. `c`/clientId is dropped from the signed payload when empty). */
export type ArcusPayload = Record<string, ArcusPayloadValue | undefined>;

const ED25519_SEED_HEX_PATTERN = /^[0-9a-fA-F]{64}$/;

export type ArcusTimeInForce = "GTT" | "FOK" | "IOC" | "ALO";
/** Engine-native TIF codes (docs/exchanges/arcus.md "Execution facts"). */
const TIME_IN_FORCE_CODES: Record<ArcusTimeInForce, number> = {
  GTT: 0,
  FOK: 1,
  IOC: 2,
  ALO: 3,
};

export type ArcusOrderSide = "buy" | "sell";

export interface ArcusOrderPayloadInput {
  /** Account address; lowercased here before signing per Scheme 1. */
  address: string;
  accountIndex: number;
  clientId?: string;
  /** Client timestamp in nanoseconds — must equal the X-Timestamp header. */
  clientTimestampNs: bigint;
  /** goodTilTime in nanoseconds (Arcus requires >= 1 month in the future). */
  goodTilTimeNs: bigint;
  marketId: number;
  priceTicks: bigint;
  quantityQuantums: bigint;
  reduceOnly: boolean;
  side: ArcusOrderSide;
  timeInForce: ArcusTimeInForce;
}

export interface ArcusCancelOrderPayloadInput {
  address: string;
  accountIndex: number;
  /** Client timestamp in nanoseconds — must equal the X-Timestamp header. */
  clientTimestampNs: bigint;
  marketId: number;
  /** Exactly one of orderId or clientId is required. */
  orderId?: string;
  clientId?: string;
}

/** BigInt-safe canonical JSON: keys sorted, no whitespace, strings
 * verbatim (JSON.stringify), bigints as raw integer literals, booleans as
 * true/false. Numbers must be safe integers — anything larger must arrive
 * as bigint or the serializer fails closed. */
export function canonicalArcusJson(payload: ArcusPayload): string {
  const entries = Object.entries(payload)
    .filter((entry): entry is [string, ArcusPayloadValue] => entry[1] !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([key, value]) => `${JSON.stringify(key)}:${canonicalLiteral(value)}`)
    .join(",")}}`;
}

function canonicalLiteral(value: ArcusPayloadValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (!Number.isSafeInteger(value))
    throw new Error(
      "Arcus canonical JSON: number values must be safe integers; pass nanosecond timestamps as bigint",
    );
  return value.toString(10);
}

/** Scheme 1 signing: the signed message IS the canonical JSON payload
 * itself (placeOrder op=1, cancelOrder op=2, TPSL placement op=4).
 * Returns the 64-byte Ed25519 signature as 128 lowercase hex chars. */
export function signArcusTypedPayload(
  payload: ArcusPayload,
  privateKeyHex: string,
): string {
  const message = new TextEncoder().encode(canonicalArcusJson(payload));
  return bytesToHex(ed25519.sign(message, seedBytes(privateKeyHex)));
}

/** Scheme 2 signing: ed25519(timestamp + action + canonicalJSON(body)) for
 * setLeverage / cancelAllOrders. `timestampNs` is the same nanosecond
 * decimal string sent in the X-Timestamp header. Returns 128 hex chars. */
export function signArcusLegacyMessage(
  input: {
    timestampNs: string | bigint;
    action: string;
    body: ArcusPayload;
  },
  privateKeyHex: string,
): string {
  const timestamp =
    typeof input.timestampNs === "bigint"
      ? input.timestampNs.toString(10)
      : input.timestampNs;
  if (!/^\d+$/.test(timestamp))
    throw new Error("Arcus legacy signature timestamp must be decimal ns");
  const message = new TextEncoder().encode(
    `${timestamp}${input.action}${canonicalArcusJson(input.body)}`,
  );
  return bytesToHex(ed25519.sign(message, seedBytes(privateKeyHex)));
}

/** Scheme 1 payload for POST /v1/placeOrder (op=1). Fields per
 * docs/exchanges/arcus.md: ad, ai, c?, ct, g, m, op, p, q, r, s, t, v. */
export function buildPlaceOrderPayload(
  input: ArcusOrderPayloadInput,
): ArcusPayload {
  return buildOrderPayload(1, input);
}

/** Scheme 1 payload for an untriggered TP/SL trigger order (op=4) — same
 * field shape as op=1; the REST body additionally carries stopPrice and
 * tpslType. */
export function buildUntriggeredTpslPayload(
  input: ArcusOrderPayloadInput,
): ArcusPayload {
  return buildOrderPayload(4, input);
}

function buildOrderPayload(
  op: 1 | 4,
  input: ArcusOrderPayloadInput,
): ArcusPayload {
  if (input.priceTicks <= 0n)
    throw new Error("Arcus order payload price ticks must be positive");
  if (input.quantityQuantums <= 0n)
    throw new Error("Arcus order payload quantity quantums must be positive");
  const payload: ArcusPayload = {
    ad: input.address.toLowerCase(),
    ai: input.accountIndex,
    ct: input.clientTimestampNs,
    g: input.goodTilTimeNs,
    m: input.marketId,
    op,
    p: input.priceTicks,
    q: input.quantityQuantums,
    r: input.reduceOnly ? 1 : 0,
    s: input.side === "buy" ? 0 : 1,
    t: TIME_IN_FORCE_CODES[input.timeInForce],
    v: 1,
  };
  // `c` is omitted from the signed payload when empty (Scheme 1 rule).
  if (input.clientId) payload.c = input.clientId;
  return payload;
}

/** Scheme 1 payload for POST /v1/cancelOrder (op=2): ad, ai, exactly one of
 * c/id, ct, m, op, v. */
export function buildCancelOrderPayload(
  input: ArcusCancelOrderPayloadInput,
): ArcusPayload {
  const orderId = input.orderId?.trim();
  const clientId = input.clientId?.trim();
  if ((orderId !== undefined && orderId !== "") === (clientId !== undefined && clientId !== ""))
    throw new Error(
      "Arcus cancel payload requires exactly one of orderId or clientId",
    );
  const payload: ArcusPayload = {
    ad: input.address.toLowerCase(),
    ai: input.accountIndex,
    ct: input.clientTimestampNs,
    m: input.marketId,
    op: 2,
    v: 1,
  };
  if (orderId) payload.id = orderId;
  if (clientId) payload.c = clientId;
  return payload;
}

/** Exact decimal -> integer conversion (price / tickSize, size / stepSize).
 * Fails closed when the division has a remainder — the engine only accepts
 * integer ticks/quantums and silent rounding would shift the signed price
 * away from the human-readable REST body. */
export function priceToTicks(priceUsd: string, tickSizeUsd: string): bigint {
  return decimalToIntegerUnits(priceUsd, tickSizeUsd, "price");
}

export function sizeToQuantums(sizeBase: string, stepSizeBase: string): bigint {
  return decimalToIntegerUnits(sizeBase, stepSizeBase, "size");
}

export function decimalToIntegerUnits(
  value: string,
  unit: string,
  label: string,
): bigint {
  const v = parseDecimalParts(value, label);
  const u = parseDecimalParts(unit, `${label} unit`);
  const numerator = v.mantissa * u.scale;
  const denominator = u.mantissa * v.scale;
  if (denominator <= 0n) throw new Error(`${label} unit must be positive`);
  if (numerator % denominator !== 0n)
    throw new Error(
      `${label} ${value} is not an exact multiple of ${unit}; refusing to round a signed order price/size`,
    );
  return numerator / denominator;
}

/** Round a decimal string to a multiple of `step` in integer (BigInt) math
 * — no floating point. "up" rounds away from zero on remainder, "down"
 * truncates toward zero (exact for positive prices/sizes). */
export function roundDecimalToStep(
  value: string,
  step: string,
  direction: "up" | "down",
): string {
  const v = parseDecimalParts(value, "value");
  const s = parseDecimalParts(step, "step");
  if (s.mantissa <= 0n) throw new Error("step must be positive");
  const numerator = v.mantissa * s.scale;
  const denominator = s.mantissa * v.scale;
  let units = numerator / denominator;
  if (direction === "up" && numerator % denominator !== 0n) units += 1n;
  return formatDecimalParts(units * s.mantissa, s.scale);
}

function parseDecimalParts(
  value: string,
  label: string,
): { mantissa: bigint; scale: bigint } {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new Error(`${label} must be a decimal string, got ${value}`);
  const mantissa = BigInt(
    `${match[1] === "-" ? "-" : ""}${match[2]}${match[3] ?? ""}`,
  );
  return { mantissa, scale: 10n ** BigInt((match[3] ?? "").length) };
}

function formatDecimalParts(mantissa: bigint, scale: bigint): string {
  const negative = mantissa < 0n;
  const abs = negative ? -mantissa : mantissa;
  const scaleDigits = scale.toString(10).length - 1;
  const raw = abs.toString(10).padStart(scaleDigits + 1, "0");
  const intPart = raw.slice(0, raw.length - scaleDigits);
  const fracPart = raw.slice(raw.length - scaleDigits).replace(/0+$/, "");
  return `${negative ? "-" : ""}${fracPart ? `${intPart}.${fracPart}` : intPart}`;
}

function seedBytes(privateKeyHex: string): Uint8Array {
  if (!ED25519_SEED_HEX_PATTERN.test(privateKeyHex))
    throw new Error(
      "Arcus private key must be a 64-hex-char (32-byte) Ed25519 seed",
    );
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1)
    bytes[i] = Number.parseInt(privateKeyHex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
