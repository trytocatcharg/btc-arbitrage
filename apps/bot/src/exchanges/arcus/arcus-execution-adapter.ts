import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import type {
  BestBidOffer,
  ExecutionAdapter,
  ExecutionOrder,
  ExecutionOrderRequest,
  ExchangePosition,
  MarketMetadata,
  PriceRequest,
} from "@btc-arbitrage/exchange-core";
import { ArcusHttpClient, ArcusHttpError } from "./arcus-http-client.js";
import { logExchangeResponse } from "../exchange-response-logger.js";
import type { ArcusConfig } from "./arcus.types.js";
import { findMarket } from "../market-normalization.js";
import {
  buildCancelOrderPayload,
  buildPlaceOrderPayload,
  buildUntriggeredTpslPayload,
  priceToTicks,
  roundDecimalToStep,
  signArcusLegacyMessage,
  signArcusTypedPayload,
  sizeToQuantums,
  type ArcusOrderPayloadInput,
  type ArcusPayload,
  type ArcusTimeInForce,
} from "./arcus-signing.js";

/** Protective price bound for MARKET orders and TP/SL triggers, in basis
 * points beyond the reference price (BBO best for MARKET, stopPrice for
 * TPSL). The bound is additionally clamped into the hard-rule band below,
 * so 150 bps only needs to guarantee a fill, not to satisfy the 10% rule
 * (same constant Extended uses). */
const MARKET_CROSSING_BUFFER_BPS = 150;

/** Hard-rule clamp: MARKET `price` must sit within 10% of MARK price and
 * TPSL MARKET within 10% of `stopPrice`. Bounds are clamped to ±9.5% of
 * the anchor so the post-clamp tick round can never breach the 10% limit.
 * Basis points: 9.5% = 950 bps (same unit as MARKET_CROSSING_BUFFER_BPS). */
const MARKET_BOUND_BAND_BPS = 950;

/** Near-static market metadata (tick/step sizes) rotates rarely; a stale
 * entry is TTL-bounded and any resulting rejection surfaces loudly. Same
 * TTL discipline as the Extended execution adapter. */
const EXCHANGE_STATIC_DATA_TTL_MS = 10 * 60 * 1000;

/** Lookback window for the leg-closure fills fallback (the epoch-µs `from`
 * query on GET /v1/fills): wide enough to cover monitor downtime and the
 * stale-closing recovery sweep, since a manual close or a moved trigger
 * only leaves fills behind. */
const FILLS_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** Closure reconstruction tolerance: a fill run whose cumulative size lands
 * within this epsilon of the leg quantity is accepted as fully closed
 * (venue-reported sizes can carry rounding). */
const CLOSURE_QTY_EPSILON = "0.000000001";

/** Arcus account index is fixed at 0 — the bot operates a single account
 * and there is no env knob for this (docs/exchanges/arcus.md). */
const ARCUS_ACCOUNT_INDEX = 0;
/** The bot is BTC-only today; position polling and the cancel payload's
 * marketId need a market even where the ExecutionAdapter contract does not
 * carry a symbol. */
const DEFAULT_ARCUS_SYMBOL = "BTCUSDT";

const NS_PER_MS = 1_000_000n;
const US_PER_MS = 1_000n;
const MS_PER_DAY = 86_400_000;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,36}$/;
const CLIENT_ID_MAX_CHARS = 36;

/** Arcus base-tier fee schedule, resolved from the public
 * GET /v1/feetiers table. Basis points as exact decimal strings (maker
 * can be negative — a rebate). */
export interface ArcusFeeSchedule {
  makerBps: string;
  takerBps: string;
}

/** ExecutionAdapter for Arcus plus the extra startup hooks the bot's
 * execution setup calls once at boot: setLeverage (signed) and
 * getBaseFeeSchedule (public fee-tier table). Not part of the
 * ExecutionAdapter contract. */
export interface ArcusExecutionHandle extends ExecutionAdapter {
  setLeverage(input: { symbol: string; leverage: number }): Promise<void>;
  /** Public, unauthenticated: reads GET /v1/feetiers and returns the base
   * tier (level 0, volume_threshold 0 — the most expensive, conservative
   * tier) as exact bps strings. TTL-cached like other static data. */
  getBaseFeeSchedule(): Promise<ArcusFeeSchedule>;
}

export function createArcusExecutionAdapter(
  config: ArcusConfig,
  http: ArcusHttpClient,
): ArcusExecutionHandle {
  return new ArcusExecutionAdapter(config, http);
}

class ArcusExecutionAdapter implements ArcusExecutionHandle {
  private readonly marketCache = new Map<
    string,
    { value: Record<string, unknown>; expiresAt: number }
  >();
  private feeScheduleCache:
    | { value: ArcusFeeSchedule; expiresAt: number }
    | undefined;
  /** Memoized per-orderId fee recovery for getExecutionOrder (see
   * resolveOrderFeeCached): a filled order's fee never changes, so the
   * hedge re-poll loop re-reads the cache instead of /v1/fills. A null
   * entry means "no fill of this order found" — also cached, since the
   * venue lists fills before the order reads FILLED. */
  private readonly orderFeeCache = new Map<string, string | null>();

  constructor(
    private readonly config: ArcusConfig,
    private readonly http: ArcusHttpClient,
  ) {}

  async getBestBidOffer(input: PriceRequest): Promise<BestBidOffer> {
    const bbo = requiredRecord(
      await this.http.get(
        `/v1/bbo/${encodeURIComponent(arcusMarketName(input.symbol))}`,
      ),
      "Arcus BBO",
    );
    const bid = arcusBboPrice(bbo.bestBid);
    const ask = arcusBboPrice(bbo.bestAsk);
    // Arcus returns null for an empty side; only fail when BOTH sides are
    // missing (a one-sided book still prices the crossing direction).
    if (bid === undefined && ask === undefined)
      throw new Error("Arcus BBO has neither bid nor ask");
    const bidUsd = bid ?? ask;
    const askUsd = ask ?? bid;
    return { bidUsd: bidUsd!, askUsd: askUsd!, receivedAt: new Date() };
  }

  async getMarketMetadata(input: PriceRequest): Promise<MarketMetadata> {
    const market = await this.getMarket(input.symbol);
    return {
      minQuantityBase: decimalField(
        market,
        ["minOrderSize"],
        "market.minOrderSize",
      ),
      quantityStepBase: decimalField(market, ["stepSize"], "market.stepSize"),
      priceTickUsd: decimalField(market, ["tickSize"], "market.tickSize"),
      // Arcus has no maxLeverage field (docs/exchanges/arcus.md).
      maxLeverage: undefined,
      positionMode: "one-way",
    };
  }

  async getAvailableMarginUsd(): Promise<string> {
    this.requireAccountAddress();
    let payload: unknown;
    try {
      payload = await this.http.get("/v1/account", {
        address: this.config.accountAddress!,
        accountIndex: String(ARCUS_ACCOUNT_INDEX),
      });
    } catch (error) {
      // GET /v1/account returns 404 until the first deposit — translate
      // that into an actionable message instead of a bare HTTP error.
      if (error instanceof ArcusHttpError && error.status === 404)
        throw new Error(
          "Arcus account has no activity yet — fund the account (GET /v1/account returns 404 until the first deposit)",
        );
      throw error;
    }
    const account = requiredRecord(payload, "Arcus account");
    return decimalField(account, ["freeCollateral"], "account.freeCollateral");
  }

  async validateExecutionPreflight(input: {
    symbol: string;
    leverage: number;
  }): Promise<void> {
    this.requireTradingEnabled();
    this.requireCredentials();
    const [metadata, availableMargin] = await Promise.all([
      this.getMarketMetadata({
        symbol: input.symbol,
        marketType: "perpetual",
        priceSource: "last",
      }),
      this.getAvailableMarginUsd(),
    ]);
    void metadata; // metadata fetch doubles as the readiness probe
    if (Number(availableMargin) <= 0)
      throw new Error("Arcus available margin (freeCollateral) is zero");
    // Process-lifetime setup hoisted to startup (main.ts runs preflight
    // once at boot), mirroring the RISEx pattern: apply the configured
    // leverage before the first order. setLeverage resolves the market id
    // from the same cached /v1/markets metadata fetched above.
    await this.setLeverage({ symbol: input.symbol, leverage: input.leverage });
  }

  async submitExecutionOrder(
    input: ExecutionOrderRequest,
  ): Promise<ExecutionOrder> {
    this.requireTradingEnabled();
    this.requireCredentials();
    const clientId = validateClientId(
      normalizeArcusClientId(input.clientOrderId),
    );
    const market = await this.getMarket(input.symbol);
    const marketId = arcusMarketId(market);
    const tickSize = decimalField(market, ["tickSize"], "market.tickSize");
    const stepSize = decimalField(market, ["stepSize"], "market.stepSize");
    const quantityQuantums = sizeToQuantums(input.quantityBase, stepSize);
    if (quantityQuantums <= 0n)
      throw new Error("Arcus order quantity must be positive");

    // goodTilTime is required on EVERY Arcus order (including IOC/FOK) and
    // must be at least 1 month in the future; the engine cancels at expiry.
    const nowMs = Date.now();
    const timestampNs = BigInt(nowMs) * NS_PER_MS;
    const expirationMs = BigInt(this.config.orderExpirationDays) * BigInt(MS_PER_DAY);
    const goodTilTimeNs = timestampNs + expirationMs * NS_PER_MS;
    const goodTilTimeUs = (BigInt(nowMs) + expirationMs) * US_PER_MS;

    const side = input.side;
    const orderSpec = await this.buildOrderSpec(input, side, tickSize);
    const payloadInput: ArcusOrderPayloadInput = {
      address: this.config.accountAddress!,
      accountIndex: ARCUS_ACCOUNT_INDEX,
      clientId,
      clientTimestampNs: timestampNs,
      goodTilTimeNs,
      marketId,
      priceTicks: priceToTicks(orderSpec.priceUsd, tickSize),
      quantityQuantums,
      reduceOnly: orderSpec.reduceOnly,
      side,
      timeInForce: orderSpec.timeInForce,
    };
    const payload =
      input.type === "take-profit-market" || input.type === "stop-market"
        ? buildUntriggeredTpslPayload(payloadInput)
        : buildPlaceOrderPayload(payloadInput);
    const signature = signArcusTypedPayload(payload, this.config.privateKey!);

    const body: Record<string, unknown> = {
      address: this.config.accountAddress!,
      marketId,
      accountIndex: ARCUS_ACCOUNT_INDEX,
      orderSide: side.toUpperCase(),
      orderType: orderSpec.orderType,
      quantity: input.quantityBase,
      price: orderSpec.priceUsd,
      timeInForce: orderSpec.timeInForce,
      timestamp: timestampNs.toString(10),
      goodTilTime: goodTilTimeUs.toString(10),
      reduceOnly: orderSpec.reduceOnly,
    };
    if (clientId) body.clientId = clientId;
    if (orderSpec.stopPriceUsd) body.stopPrice = orderSpec.stopPriceUsd;
    if (orderSpec.tpslType) body.tpslType = orderSpec.tpslType;

    const isTpsl =
      input.type === "take-profit-market" || input.type === "stop-market";

    if (isTpsl) {
      // Arcus does not support single-order TP/SL: placeOrder with a
      // tpslType returns 501 NotImplemented (verified live 2026-10-01).
      // TPSL legs must travel as POST /v1/batchPlaceOrders with grouping
      // "partialTpsl" — 1–2 legs per batch, so a single TP or SL per call
      // matches the executor's per-order flow. Each element embeds its own
      // Scheme 1 op=4 signature; the X-Signature header must be present
      // (any element's signature); the top-level grouping is not signed.
      const element = { ...body, signature };
      const batch = requiredRecord(
        await this.http.post(
          "/v1/batchPlaceOrders",
          { grouping: "partialTpsl", orders: [element] },
          {
            query: { address: this.config.accountAddress! },
            signature: { timestampNs: timestampNs.toString(10), signature },
          },
        ),
        "Arcus batchPlaceOrders response",
      );
      const rows = Array.isArray(batch.responses) ? batch.responses : undefined;
      const row = isRecord(rows?.[0]) ? rows[0] : undefined;
      if (!row)
        throw new Error("Arcus batchPlaceOrders returned no response rows");
      const rowError = optionalString(row.error);
      if (rowError) throw new Error(`Arcus TPSL order rejected: ${rowError}`);
      const mapped = mapExecutionOrder(row);
      if (mapped.status === "rejected") {
        const reason = optionalString(row.rejectionReason);
        throw new Error(`Arcus order rejected${reason ? `: ${reason}` : ""}`);
      }
      logExchangeResponse({
        exchange: "arcus",
        event: "tpsl_place",
        context: {
          symbol: input.symbol,
          side: input.side,
          type: input.type,
          reduceOnly: orderSpec.reduceOnly,
          quantityBase: input.quantityBase,
          stopPriceUsd: orderSpec.stopPriceUsd,
        },
        response: row,
      });
      return mapped;
    }

    const placed = requiredRecord(
      await this.http.post("/v1/placeOrder", body, {
        query: { address: this.config.accountAddress! },
        signature: { timestampNs: timestampNs.toString(10), signature },
      }),
      "Arcus placeOrder response",
    );
    const mapped = mapExecutionOrder(placed);
    // A definitive (HTTP 200) REJECTED must surface loudly — including the
    // venue rejection reason: a post-only ALO that would cross arrives here
    // as POST_ONLY_WOULD_CROSS, which the trade executor retries. A 202 ACK
    // carries no terminal state and maps to "new".
    if (mapped.status === "rejected") {
      const reason = optionalString(placed.rejectionReason);
      throw new Error(
        `Arcus order rejected${reason ? `: ${reason}` : ""}`,
      );
    }
    logExchangeResponse({
      exchange: "arcus",
      event: "order_submit",
      context: {
        symbol: input.symbol,
        side: input.side,
        type: input.type,
        reduceOnly: orderSpec.reduceOnly,
        quantityBase: input.quantityBase,
        priceUsd: orderSpec.priceUsd,
      },
      response: placed,
    });

    if (input.type === "market") {
      // MARKET orders may fill immediately; make a single best-effort read
      // for the definitive record, then degrade to the placement-time
      // state.
      try {
        return await this.getExecutionOrder(mapped.id);
      } catch {
        return mapped;
      }
    }
    return mapped;
  }

  async getExecutionOrder(orderId: string): Promise<ExecutionOrder> {
    this.requireAccountAddress();
    const record = unwrapOrderRecord(
      await this.http.get(
        `/v1/order/${encodeURIComponent(orderId)}`,
        { address: this.config.accountAddress! },
      ),
    );
    const mapped = mapExecutionOrder(record);
    // Polled every tick while a leg rests open — log only fill/terminal
    // states (same discipline as the RISEx/Extended adapters).
    if (
      mapped.status === "filled" ||
      mapped.status === "rejected" ||
      mapped.status === "cancelled"
    ) {
      logExchangeResponse({
        exchange: "arcus",
        event: "order_read",
        context: { orderId, status: mapped.status },
        response: record,
      });
    }
    if (mapped.status === "filled" && mapped.feeUsd === undefined) {
      // Arcus order records carry no fee field (docs/exchanges/arcus.md
      // "Execution facts") — recover the REAL per-fill fee from the
      // public fills history, matched strictly by orderId (trade #447:
      // the market-hedge entry fee stayed unknown without this). The
      // fills fetch filters by market display name, which the order
      // record carries; the bot is BTC-only, so a missing name falls
      // back to the default market. Memoized per orderId so the hedge
      // re-poll loop does not hammer /v1/fills. Real value only — on any
      // failure the fee stays absent, never estimated.
      try {
        const marketName =
          optionalString(record.marketDisplayName) ??
          arcusMarketName(DEFAULT_ARCUS_SYMBOL);
        const feeUsd = await this.resolveOrderFeeCached(marketName, orderId);
        if (feeUsd !== undefined) mapped.feeUsd = feeUsd;
      } catch {
        // Best-effort; the order record stands alone without a fee.
      }
    }
    return mapped;
  }

  async cancelExecutionOrder(orderId: string): Promise<void> {
    this.requireTradingEnabled();
    this.requireCredentials();
    // The cancel payload must name the market; the contract only carries
    // the order id, and the bot is BTC-only (DEFAULT_ARCUS_MARKET_NAME).
    const market = await this.getMarket(DEFAULT_ARCUS_SYMBOL);
    const timestampNs = BigInt(Date.now()) * NS_PER_MS;
    const payload = buildCancelOrderPayload({
      address: this.config.accountAddress!,
      accountIndex: ARCUS_ACCOUNT_INDEX,
      clientTimestampNs: timestampNs,
      marketId: arcusMarketId(market),
      orderId,
    });
    const signature = signArcusTypedPayload(payload, this.config.privateKey!);
    // The Scheme-1 payload (with `ct` as bigint) is the signing input ONLY
    // — it must never travel as the REST body, or JSON.stringify throws
    // "Do not know how to serialize a BigInt" on every cancel. Build a
    // separate JSON-safe body, exactly like submitExecutionOrder does for
    // placeOrder (long-form fields, string timestamp).
    const body: Record<string, unknown> = {
      address: this.config.accountAddress!,
      marketId: arcusMarketId(market),
      accountIndex: ARCUS_ACCOUNT_INDEX,
      orderId,
      timestamp: timestampNs.toString(10),
    };
    await this.http.post("/v1/cancelOrder", body, {
      query: { address: this.config.accountAddress! },
      signature: { timestampNs: timestampNs.toString(10), signature },
    });
  }

  async getPosition(input: {
    symbol: string;
    side: "long" | "short";
  }): Promise<ExchangePosition | null> {
    this.requireAccountAddress();
    const marketName = arcusMarketName(input.symbol);
    const market = await this.getMarket(input.symbol);
    const marketId = String(arcusMarketId(market));
    const payload = requiredRecord(
      await this.http.get("/v1/positions", {
        address: this.config.accountAddress!,
        market: marketName,
      }),
      "Arcus positions",
    );
    const positions = requiredRecord(
      payload.positions,
      "Arcus positions map",
    );
    const position = findPositionRecord(positions, marketId);
    if (!position) return null;
    const signedSize = decimalField(position, ["size"], "position.size");
    const parsedSize = Number(signedSize);
    if (!Number.isFinite(parsedSize) || parsedSize === 0) return null;
    const side = parsedSize > 0 ? "long" : "short";
    // Only report a position when its sign matches the requested side
    // (a signed size reads directly as direction).
    if (side !== input.side) return null;
    return {
      side,
      quantityBase: signedSize.replace("-", ""),
      entryPriceUsd: findDecimal(position, [
        "averageEntryPrice",
        "avgEntryPrice",
        "entryPrice",
      ]),
      status: "open",
    };
  }

  /** Best-effort recovery of the exit data for a leg the position monitor
   * already detected as flat (venue-side TP/SL fire): /v1/positions no
   * longer reports the entry once flat, so the closure is reconstructed
   * from the stored TP/SL order ids via GET /v1/order/{orderId}. A fired
   * trigger reports filledSize > 0 / avgFillPrice > 0; anything else
   * (UNTRIGGERED, zero-filled) is treated as not fired — undocumented
   * statuses are never guessed. When the stored ids resolve nothing
   * (operator moved/replaced the trigger, or closed by hand), falls back
   * to the public GET /v1/fills history: close fills (positionEffect
   * CLOSE_<side>, side-mapped when absent) inside a 24 h window are walked
   * newest-first until the cumulative size reaches the leg quantity
   * (VWAP exit price, summed fee/closedPnl), or the single newest fill
   * when no quantity is known. Degrades to null on any failure. */
  async resolveLegClosure(input: {
    symbol: string;
    side: "long" | "short";
    tpOrderId?: string;
    slOrderId?: string;
    quantityBase?: string;
  }): Promise<{
    exitPriceUsd?: string;
    realizedPnlUsd?: string;
    exitOrderId?: string;
    closeReason?: "tp" | "sl" | "manual" | "liquidation";
    feeUsd?: string;
  } | null> {
    try {
      this.requireAccountAddress();
    } catch {
      return null;
    }
    try {
      const fired: Array<{
        exitPriceUsd?: string;
        exitOrderId?: string;
        closeReason: "tp" | "sl";
        feeUsd?: string;
        realizedPnlUsd?: string;
      }> = [];
      for (const [kind, id] of [
        ["tp", input.tpOrderId],
        ["sl", input.slOrderId],
      ] as const) {
        if (!id) continue;
        let order: Record<string, unknown>;
        try {
          const rawOrder = await this.http.get(
            `/v1/order/${encodeURIComponent(id)}`,
            { address: this.config.accountAddress! },
          );
          order = requiredRecord(unwrapOrderRecord(rawOrder), "Arcus TPSL order");
          // A closure reads each stored trigger at most once — log always.
          logExchangeResponse({
            exchange: "arcus",
            event: "closure_order_read",
            context: { orderId: id, kind },
            response: rawOrder,
          });
        } catch {
          // Missing order: this id has nothing to teach us.
          continue;
        }
        const exitPriceUsd = positiveDecimal(
          findDecimal(order, ["avgFillPrice", "averageFillPrice", "avgPrice"]),
        );
        const filledSize = Number(
          findDecimal(order, ["filledSize", "executedSize", "cumQty"]) ?? "0",
        );
        if (exitPriceUsd === undefined && !(filledSize > 0)) continue;
        fired.push({
          exitPriceUsd,
          exitOrderId: optionalString(order.orderId) ?? optionalString(order.id),
          closeReason: kind,
          // Arcus exposes no per-order fee field: stays undefined, never
          // estimated (docs/exchanges/arcus.md "Execution facts").
          feeUsd: undefined,
        });
      }
      if (fired.length > 0) {
        const result = fired[0];
        // Arcus order records carry no fee field, but the public fills
        // history does: when the exit order id is known, recover the real
        // per-fill fee and realized PnL matched by orderId (one extra
        // request per closure; any failure degrades to the fee-less
        // result — never estimated).
        if (result.exitOrderId) {
          try {
            const byOrder = await this.resolveExitByOrderId(
              input.symbol,
              result.exitOrderId,
            );
            if (byOrder?.feeUsd !== undefined) result.feeUsd = byOrder.feeUsd;
            if (byOrder?.realizedPnlUsd !== undefined)
              result.realizedPnlUsd = byOrder.realizedPnlUsd;
          } catch {
            // Fee recovery is best-effort; the closure result stands alone.
          }
        }
        console.log("Arcus leg closure resolved", {
          closeReason: result.closeReason,
          exitOrderId: result.exitOrderId,
          exitPriceUsd: result.exitPriceUsd,
          feeUsd: result.feeUsd,
          realizedPnlUsd: result.realizedPnlUsd,
          source: "/v1/order/{orderId} + /v1/fills",
        });
        return result;
      }
      // Stored ids resolved nothing — the trigger was moved/replaced or the
      // position was closed by hand. The exit then exists ONLY in the public
      // fill history (the position record is already gone), so reconstruct
      // the closure from GET /v1/fills. Any failure here degrades to null:
      // the historical n/a behavior stays the floor.
      const recovered = await this.resolveClosureFromFills(input);
      if (recovered !== null) {
        console.log("Arcus leg closure resolved from fills", {
          closeReason: recovered.closeReason,
          exitOrderId: recovered.exitOrderId,
          exitPriceUsd: recovered.exitPriceUsd,
          feeUsd: recovered.feeUsd,
          fills: recovered.fills,
        });
      }
      return recovered;
    } catch (error) {
      console.warn("Arcus leg closure resolution failed; degrading to null", {
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** Fills-history fallback for resolveLegClosure: public, unauthenticated
   * GET /v1/fills (newest-first) holds the only record of a closure the
   * stored TP/SL ids cannot explain. Close fills are matched by
   * positionEffect (side-mapped when the field is absent), then walked
   * newest-first accumulating size until the leg quantity is covered —
   * exit price as an exact-decimal VWAP, fee/PnL summed over the accepted
   * fills — or the single newest fill when no quantity is known. A partial
   * run under 50% of the leg quantity is too speculative and yields null.
   * Throws on unexpected shapes; the caller's try degrades that to null. */
  private async resolveClosureFromFills(input: {
    symbol: string;
    side: "long" | "short";
    quantityBase?: string;
  }): Promise<{
    exitPriceUsd?: string;
    realizedPnlUsd?: string;
    exitOrderId?: string;
    closeReason?: "tp" | "sl" | "manual" | "liquidation";
    feeUsd?: string;
    fills: number;
  } | null> {
    this.requireAccountAddress();
    const fills = await this.fetchFills(input.symbol);
    const closeEffect = input.side === "long" ? "CLOSE_LONG" : "CLOSE_SHORT";
    // Fallback when positionEffect is absent: a long closes by selling, a
    // short by buying.
    const closingSide = input.side === "long" ? "SELL" : "BUY";
    const matched: Record<string, unknown>[] = [];
    for (const fill of fills) {
      if (!isRecord(fill)) continue;
      const effect = optionalString(fill.positionEffect)?.toUpperCase();
      if (effect !== undefined) {
        if (effect === closeEffect) matched.push(fill);
        continue;
      }
      if (optionalString(fill.side)?.toUpperCase() === closingSide)
        matched.push(fill);
    }

    let cumulative = "0";
    let notional = "0";
    let feeUsd: string | undefined;
    let realizedPnlUsd: string | undefined;
    let sawLiquidation = false;
    let exitOrderId: string | undefined;
    let accepted = 0;
    for (const fill of matched) {
      if (
        input.quantityBase !== undefined &&
        closureQtyReached(cumulative, input.quantityBase)
      )
        break;
      const size = positiveDecimal(findDecimal(fill, ["size"]));
      const price = positiveDecimal(findDecimal(fill, ["price"]));
      // A fill without a usable size/price cannot contribute to the VWAP
      // and is skipped wholesale — never estimated.
      if (size === undefined || price === undefined) continue;
      if (accepted === 0)
        exitOrderId = optionalString(fill.orderId) ?? undefined;
      accepted += 1;
      cumulative = addDecimalStrings(cumulative, size);
      notional = addDecimalStrings(notional, mulDecimalStrings(size, price));
      // Fills expose a REAL per-fill fee (docs/exchanges/arcus.md) — a
      // maker rebate arrives negative and is preserved as-is.
      const fee = findDecimal(fill, ["fee"]);
      if (fee !== undefined) feeUsd = addDecimalStrings(feeUsd ?? "0", fee);
      const closedPnl = findDecimal(fill, ["closedPnl"]);
      if (closedPnl !== undefined)
        realizedPnlUsd = addDecimalStrings(realizedPnlUsd ?? "0", closedPnl);
      if (fill.liquidation) sawLiquidation = true;
      // No leg quantity known: the single newest matching fill is the
      // whole story.
      if (input.quantityBase === undefined) break;
    }
    // Close fills only — a bounded set (never the raw 24 h history).
    logExchangeResponse({
      exchange: "arcus",
      event: "closure_order_history_read",
      context: { symbol: input.symbol, side: input.side, quantityBase: input.quantityBase },
      response: { fills: matched },
    });
    if (accepted === 0) return null;
    if (
      input.quantityBase !== undefined &&
      !closureQtyReached(cumulative, input.quantityBase) &&
      // Partial coverage is accepted only at ≥ 50% of the leg quantity;
      // below that the reconstruction is too speculative.
      compareDecimals(mulDecimalStrings(cumulative, "2"), input.quantityBase) < 0
    )
      return null;

    const exitPriceUsd = divideScaledDecimal(notional, cumulative);
    return {
      exitPriceUsd,
      exitOrderId,
      closeReason: sawLiquidation ? "liquidation" : "manual",
      ...(realizedPnlUsd !== undefined ? { realizedPnlUsd } : {}),
      ...(feeUsd !== undefined ? { feeUsd } : {}),
      fills: accepted,
    };
  }

  /** Fetch the public fills history for a symbol (24 h lookback,
   * newest-first per the venue doc). Shared by the closure reconstruction
   * and the exit-order fee recovery. */
  private async fetchFills(symbol: string): Promise<Record<string, unknown>[]> {
    this.requireAccountAddress();
    // Same market resolution as getPosition: arcusMarketName derives the
    // display name the fills endpoint filters on; getMarket additionally
    // validates the market exists (and warms the TTL cache).
    await this.getMarket(symbol);
    return this.fetchFillsByMarket(arcusMarketName(symbol));
  }

  /** Fetch the public fills history filtered by an explicit venue market
   * display name (e.g. "BTC-USD"). Used by paths that only know the
   * order record's `marketDisplayName` (the getExecutionOrder fee
   * recovery) and therefore skip the getMarket validation/warm-up of the
   * symbol-based fetchFills. */
  private async fetchFillsByMarket(
    marketName: string,
  ): Promise<Record<string, unknown>[]> {
    this.requireAccountAddress();
    const payload = requiredRecord(
      await this.http.get("/v1/fills", {
        address: this.config.accountAddress!,
        market: marketName,
        from: String(BigInt(Date.now() - FILLS_LOOKBACK_MS) * 1000n),
      }),
      "Arcus fills",
    );
    // The venue guarantees newest-first order (docs.arcus.xyz
    // /api-reference/public/get-fills) — the accumulation below relies on
    // it so the FIRST accepted fill is the newest (exit order id source).
    const fills = Array.isArray(payload.fills) ? payload.fills : [];
    return fills.filter(isRecord);
  }

  /** Recover the real per-fill fee and realized PnL of a single exit
   * order from the public fills history (Arcus order records carry no fee
   * field — docs/exchanges/arcus.md "Execution facts"). Matched strictly
   * by orderId. Returns null when no fill of the order is present; throws
   * on unexpected shapes, so callers must degrade. */
  private async resolveExitByOrderId(
    symbol: string,
    orderId: string,
  ): Promise<{ feeUsd?: string; realizedPnlUsd?: string } | null> {
    const fills = await this.fetchFills(symbol);
    return this.sumFillsByOrderId(fills, orderId);
  }

  /** Memoized fee recovery for a single filled order, used by
   * getExecutionOrder (order records carry no fee field). The lookup is
   * matched strictly by orderId against the public fills history; only
   * the fee is consumed — realized PnL stays venue-derived elsewhere.
   * Both a resolved fee and a "no fill found" outcome are cached per
   * orderId (a filled order's fee never changes, and the venue lists
   * fills before the order reads FILLED), so the hedge re-poll loop (up
   * to 6 re-reads) hits /v1/fills at most once per order. Endpoint
   * failures are NOT cached, so a later poll can retry. Real value only;
   * undefined on any failure — never estimated. */
  private async resolveOrderFeeCached(
    marketName: string,
    orderId: string,
  ): Promise<string | undefined> {
    if (this.orderFeeCache.has(orderId))
      return this.orderFeeCache.get(orderId) ?? undefined;
    let feeUsd: string | undefined;
    try {
      const fills = await this.fetchFillsByMarket(marketName);
      feeUsd = this.sumFillsByOrderId(fills, orderId)?.feeUsd;
    } catch {
      return undefined;
    }
    this.orderFeeCache.set(orderId, feeUsd ?? null);
    return feeUsd;
  }

  /** Decimal-sum core shared by the exit-order recovery paths: fills of
   * the given orderId contribute their REAL per-fill fee (a maker rebate
   * arrives negative and is preserved as-is) and closedPnl. Returns null
   * when no fill of the order is present. */
  private sumFillsByOrderId(
    fills: Record<string, unknown>[],
    orderId: string,
  ): { feeUsd?: string; realizedPnlUsd?: string } | null {
    let feeUsd: string | undefined;
    let realizedPnlUsd: string | undefined;
    let matched = 0;
    for (const fill of fills) {
      if (optionalString(fill.orderId) !== orderId) continue;
      matched += 1;
      // Fills expose a REAL per-fill fee (docs/exchanges/arcus.md) — a
      // maker rebate arrives negative and is preserved as-is.
      const fee = findDecimal(fill, ["fee"]);
      if (fee !== undefined) feeUsd = addDecimalStrings(feeUsd ?? "0", fee);
      const closedPnl = findDecimal(fill, ["closedPnl"]);
      if (closedPnl !== undefined)
        realizedPnlUsd = addDecimalStrings(realizedPnlUsd ?? "0", closedPnl);
    }
    if (matched === 0) return null;
    return {
      ...(feeUsd !== undefined ? { feeUsd } : {}),
      ...(realizedPnlUsd !== undefined ? { realizedPnlUsd } : {}),
    };
  }

  /** Startup hook (not part of the ExecutionAdapter contract): resolves
   * the Arcus routing fees from the public GET /v1/feetiers table. The
   * endpoint is unauthenticated (no apiKey/tradingEnabled requirement)
   * and perp fees MUST be read from it (docs/exchanges/arcus.md). There
   * is no per-account tier endpoint, so the BASE tier (level 0,
   * volume_threshold 0) is used — the most expensive tier, a conservative
   * cost estimate. ppm → bps via exact integer math, no floating point.
   * TTL-cached like the market metadata. */
  async getBaseFeeSchedule(): Promise<ArcusFeeSchedule> {
    const cached = this.feeScheduleCache;
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const payload = requiredRecord(
      await this.http.get("/v1/feetiers"),
      "Arcus fee tiers",
    );
    const tiers = Array.isArray(payload.tiers) ? payload.tiers : undefined;
    if (!tiers || tiers.length === 0)
      throw new Error(
        "Arcus GET /v1/feetiers returned no fee tiers; " +
          "set ARCUS_MAKER_FEE_BPS/ARCUS_TAKER_FEE_BPS to bypass live resolution",
      );
    const base = selectBaseFeeTier(tiers);
    const makerPpm = findFeePpm(base, ["maker_fee_ppm", "makerFeePpm"]);
    const takerPpm = findFeePpm(base, ["taker_fee_ppm", "takerFeePpm"]);
    if (makerPpm === undefined || takerPpm === undefined)
      throw new Error(
        "Arcus base fee tier (level 0) has no numeric maker/taker ppm; " +
          "set ARCUS_MAKER_FEE_BPS/ARCUS_TAKER_FEE_BPS to bypass live resolution",
      );
    const value: ArcusFeeSchedule = {
      makerBps: ppmToBps(makerPpm),
      takerBps: ppmToBps(takerPpm),
    };
    this.feeScheduleCache = {
      value,
      expiresAt: Date.now() + EXCHANGE_STATIC_DATA_TTL_MS,
    };
    return value;
  }

  /** Startup hook (not part of the ExecutionAdapter contract): sets the
   * per-market leverage once at boot. Scheme 2 signing; a 202 ACK is not a
   * failure, REJECTED throws. */
  async setLeverage(input: {
    symbol: string;
    leverage: number;
  }): Promise<void> {
    this.requireTradingEnabled();
    this.requireCredentials();
    const market = await this.getMarket(input.symbol);
    const body: ArcusPayload = {
      address: this.config.accountAddress!,
      marketId: arcusMarketId(market),
      leverage: input.leverage,
      accountIndex: ARCUS_ACCOUNT_INDEX,
    };
    const timestampNs = BigInt(Date.now()) * NS_PER_MS;
    const signature = signArcusLegacyMessage(
      {
        timestampNs: timestampNs.toString(10),
        action: "setLeverage",
        body,
      },
      this.config.privateKey!,
    );
    const response = requiredRecord(
      await this.http.post("/v1/setLeverage", body, {
        query: { address: this.config.accountAddress! },
        signature: { timestampNs: timestampNs.toString(10), signature },
      }),
      "Arcus setLeverage response",
    );
    const status = optionalString(response.status)?.toUpperCase();
    if (status === "REJECTED") {
      const reason = optionalString(response.rejectionReason);
      throw new Error(
        `Arcus setLeverage rejected${reason ? `: ${reason}` : ""}`,
      );
    }
    // APPLED and ACK (including 202 ACK with no terminal state) are
    // accepted; an absent status is treated as accepted best-effort.
  }

  private async buildOrderSpec(
    input: ExecutionOrderRequest,
    side: "buy" | "sell",
    tickSize: string,
  ): Promise<{
    orderType: "LIMIT" | "MARKET";
    timeInForce: ArcusTimeInForce;
    priceUsd: string;
    reduceOnly: boolean;
    stopPriceUsd?: string;
    tpslType?: "STOP_LOSS" | "TAKE_PROFIT";
  }> {
    const reduceOnly = input.reduceOnly ?? false;
    if (input.type === "limit") {
      if (!input.priceUsd)
        throw new Error("Arcus limit order requires priceUsd");
      return {
        orderType: "LIMIT",
        // Post-only entry: ALO crossing rejects with POST_ONLY_WOULD_CROSS
        // (retryable, same semantics as Extended). A reduce-only limit
        // cannot post-only (Extended parity), so it rests as GTT.
        timeInForce: reduceOnly ? "GTT" : "ALO",
        priceUsd: roundDecimalToStep(
          input.priceUsd,
          tickSize,
          side === "buy" ? "up" : "down",
        ),
        reduceOnly,
      };
    }
    if (input.type === "market") {
      // MARKET orders carry a protective slippage bound within 10% of mark
      // (Arcus hard rule); crossingPrice clamps the BBO best + 150 bps
      // buffer into the mark ± 9.5% band.
      const bound = await this.crossingPrice(input.symbol, side, tickSize);
      return {
        orderType: "MARKET",
        timeInForce: "IOC",
        priceUsd: bound,
        reduceOnly,
      };
    }
    if (input.type === "take-profit-market" || input.type === "stop-market") {
      if (!input.triggerPriceUsd)
        throw new Error("Arcus TP/SL order requires triggerPriceUsd");
      if (!reduceOnly)
        throw new Error("Arcus TP/SL execution orders must be reduce-only");
      const stopPriceUsd = roundDecimalToStep(
        input.triggerPriceUsd,
        tickSize,
        side === "buy" ? "up" : "down",
      );
      // TPSL MARKET: price bound within 10% of stopPrice via the Extended
      // MARKET_CROSSING_BUFFER_BPS pattern, plus the same clamp discipline
      // as the MARKET bound anchored to stopPrice — a no-op guard by
      // construction (150 bps sits far inside the 10% hard rule).
      const executionPriceUsd = roundDecimalToStep(
        clampIntoPriceBand(
          applyBps(
            input.triggerPriceUsd,
            side === "buy"
              ? 10_000 + MARKET_CROSSING_BUFFER_BPS
              : 10_000 - MARKET_CROSSING_BUFFER_BPS,
          ),
          stopPriceUsd,
          MARKET_BOUND_BAND_BPS,
        ),
        tickSize,
        side === "buy" ? "up" : "down",
      );
      return {
        orderType: "MARKET",
        // Arcus hard rule (placeOrder schema): MARKET orders must be IOC —
        // including untriggered TPSL (op=4). GTT is only valid for LIMIT
        // TPSL. Verified live 2026-10-01: GTT was rejected with HTTP 400
        // "must be IOC for MARKET orders". goodTilTime is still sent
        // separately (required on every order as replay protection).
        timeInForce: "IOC",
        priceUsd: executionPriceUsd,
        reduceOnly: true,
        stopPriceUsd,
        tpslType:
          input.type === "take-profit-market" ? "TAKE_PROFIT" : "STOP_LOSS",
      };
    }
    throw new Error(`Unsupported Arcus order type: ${input.type}`);
  }

  private async crossingPrice(
    symbol: string,
    side: "buy" | "sell",
    tickSize: string,
  ): Promise<string> {
    // The BBO best ± 150 bps buffer alone can drift outside Arcus's hard
    // 10%-of-mark band on a thin or dislocated book, so the mark price
    // (from the same TTL-cached /v1/markets metadata) anchors the bound:
    // buffer first, then clamp into mark ± MARKET_BOUND_BAND_BPS.
    const [bbo, markUsd] = await Promise.all([
      this.getBestBidOffer({
        symbol,
        marketType: "perpetual",
        priceSource: "last",
      }),
      this.getMarkPriceUsd(symbol),
    ]);
    const best = side === "buy" ? bbo.askUsd : bbo.bidUsd;
    return roundDecimalToStep(
      clampIntoPriceBand(
        applyBps(
          best,
          side === "buy"
            ? 10_000 + MARKET_CROSSING_BUFFER_BPS
            : 10_000 - MARKET_CROSSING_BUFFER_BPS,
        ),
        markUsd,
        MARKET_BOUND_BAND_BPS,
      ),
      tickSize,
      side === "buy" ? "up" : "down",
    );
  }

  /** Mark price from the TTL-cached /v1/markets metadata — the anchor for
   * the MARKET protective bound. A missing or zero mark fails closed: a
   * BBO-only bound is not contract-compliant. */
  private async getMarkPriceUsd(symbol: string): Promise<string> {
    const market = await this.getMarket(symbol);
    const mark = findDecimal(market, ["markPrice", "markPx"]);
    if (mark === undefined || compareDecimals(mark, "0") <= 0)
      throw new Error(
        "Arcus market metadata has no usable markPrice; refusing to build a MARKET bound without the mark-price anchor",
      );
    return mark;
  }

  private async getMarket(
    symbol: string,
  ): Promise<Record<string, unknown>> {
    const cacheKey = `${symbol}|perpetual`;
    const cached = this.marketCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const payload = requiredRecord(
      await this.http.get("/v1/markets", {
        market: arcusMarketName(symbol),
      }),
      "Arcus markets",
    );
    const value = findArcusMarket(payload, symbol);
    this.marketCache.set(cacheKey, {
      value,
      expiresAt: Date.now() + EXCHANGE_STATIC_DATA_TTL_MS,
    });
    return value;
  }

  private requireTradingEnabled(): void {
    if (!this.config.tradingEnabled)
      throw new Error(
        "Arcus trading is disabled; set ARCUS_TRADING_ENABLED=true only after credentials and risk controls are ready",
      );
  }

  private requireCredentials(): void {
    if (!this.config.apiKey)
      throw new Error(
        "ARCUS_API_KEY is required for Arcus live execution",
      );
    if (!this.config.privateKey)
      throw new Error(
        "ARCUS_API_PRIVATE_KEY is required for Arcus live execution",
      );
    this.requireAccountAddress();
  }

  private requireAccountAddress(): void {
    if (!this.config.accountAddress)
      throw new Error(
        "ARCUS_ACCOUNT_ADDRESS is required for Arcus account-scoped requests",
      );
  }
}

function mapExecutionOrder(payload: unknown): ExecutionOrder {
  const order = requiredRecord(payload, "Arcus order");
  return {
    id:
      optionalString(order.orderId) ??
      optionalString(order.id) ??
      fail("Arcus order response did not include an order id"),
    status: mapOrderStatus(optionalString(order.status)),
    filledQuantityBase:
      findDecimal(order, ["filledSize", "executedSize", "cumQty"]) ?? "0",
    averageFillPriceUsd: findDecimal(order, [
      "avgFillPrice",
      "averageFillPrice",
      "avgPrice",
    ]),
    // Arcus has no per-order fee field — undefined, never estimated
    // (docs/exchanges/arcus.md "Execution facts").
    feeUsd: undefined,
  };
}

function mapOrderStatus(status: string | undefined): ExecutionOrder["status"] {
  switch (status?.toUpperCase() ?? "ACK") {
    case "ACK":
    case "PENDING":
    case "OPEN":
    case "UNTRIGGERED":
      return "new";
    case "PARTIALLY_FILLED":
      return "partially_filled";
    case "FILLED":
      return "filled";
    case "CANCELED":
    case "CANCELLED":
    // Exotic terminals that all end the order's life: the mass-cancel
    // paths (CANCEL_ALL_* family), acknowledged cancel requests, TP/SL
    // lifecycle cancellations, and forced exits (liquidation / ADL).
    case "CANCEL_ALL_IN_FLIGHT":
    case "CANCEL_ALL_PARTIALLY_FILLED":
    case "CANCEL_ALL_FAILED":
    case "CANCEL_ACKNOWLEDGED":
    case "TPSL_CANCELED":
    case "MARGIN_CANCELED":
    case "LIQUIDATED":
    case "ADL":
      return "cancelled";
    case "REJECTED":
    case "ERROR":
      return "rejected";
    // Trigger order accepted / stop fired with the reduce-only execution
    // still live — legit live states, reported like any other open order.
    case "TPSL_PLACED":
    case "TPSL_TRIGGERED":
      return "new";
    default:
      // Unknown statuses degrade to live-state reporting on purpose: the
      // executor keeps polling, and trade-monitor's resolveLegClosure
      // reads fills, not status, so a wrong "new" cannot fake a closure.
      return "new";
  }
}

function arcusMarketName(symbol: string): string {
  const normalized = symbol.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  if (normalized.endsWith("USDT") || normalized.endsWith("USDC"))
    return `${normalized.slice(0, -4)}-USD`;
  if (normalized.endsWith("USD")) return `${normalized.slice(0, -3)}-USD`;
  return symbol.includes("-") ? symbol.toUpperCase() : symbol;
}

function arcusMarketId(market: Record<string, unknown>): number {
  const raw =
    market.marketId ?? market.market_id ?? market.id ?? market.market;
  const numeric = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(numeric))
    throw new Error("Arcus market response did not include a usable marketId");
  return numeric;
}

function findArcusMarket(
  payload: Record<string, unknown>,
  symbol: string,
): Record<string, unknown> {
  // The shared matcher maps bot symbols to venue markets via exact match
  // first, then base-asset fallback (BTCUSDT -> BTC matches Arcus's
  // BTC-USD / baseAsset "BTC") — the same resolution the market-data
  // client relies on. A local exact-only matcher rejected BTCUSDT here
  // (observed 2026-10-01: preflight died at boot).
  const market = findMarket(payload, symbol, "perpetual");
  if (market.status && String(market.status).toUpperCase() !== "ONLINE") {
    throw new Error(`Arcus market ${symbol} is not ONLINE`);
  }
  return market;
}

function arcusBboPrice(level: unknown): string | undefined {
  if (!isRecord(level)) return undefined;
  const price = level.price;
  if (typeof price !== "string" && typeof price !== "number") return undefined;
  return String(price);
}

/** Arcus caps clientId at 36 chars; the open-trade flow builds ids like
 * `${uuid}-tp` / `-hedge-1` (up to 45+ chars), which the venue would
 * reject outright. Normalize oversized ids deterministically at the
 * adapter boundary: keep a short readable prefix plus a SHA-256 hex
 * digest of the FULL original id.
 *
 * - Deterministic: the same logical order yields the same clientId on
 *   retry, so idempotent placement/cancel keep matching the order.
 * - Collision-resistant across suffixes of the same token: truncating
 *   the head would collapse the tp/sl/hedge variants of one uuid into
 *   DUPLICATE_CLIENT_ID; the digest separates them (~116 bits of entropy).
 * - Charset stays [A-Za-z0-9_-], length ≤ 36.
 *
 * Ids that already satisfy the venue rule pass through untouched. */
function normalizeArcusClientId(clientOrderId: string): string {
  if (!clientOrderId || CLIENT_ID_PATTERN.test(clientOrderId))
    return clientOrderId;
  const prefix = clientOrderId.slice(0, 6).replace(/[^A-Za-z0-9_-]/g, "_");
  const digest = bytesToHex(
    sha256(new TextEncoder().encode(clientOrderId)),
  ).slice(0, CLIENT_ID_MAX_CHARS - prefix.length - 1);
  return `${prefix}-${digest}`;
}

function validateClientId(clientOrderId: string): string | undefined {
  if (!clientOrderId) return undefined;
  if (!CLIENT_ID_PATTERN.test(clientOrderId))
    throw new Error(
      `Arcus clientId must match [A-Za-z0-9_-] and be at most 36 chars, got "${clientOrderId}"`,
    );
  return clientOrderId;
}

/** Clamp `priceUsd` into `anchorUsd ± bandBps` with exact BigInt math —
 * string comparison is unsafe for decimals of differing magnitude. Arcus
 * hard-rules MARKET bounds to within 10% of the anchor (mark price, or
 * stopPrice for TPSL); the 9.5% band leaves headroom for the tick round
 * that follows the clamp. */
function clampIntoPriceBand(
  priceUsd: string,
  anchorUsd: string,
  bandBps: number,
): string {
  const lower = applyBps(anchorUsd, 10_000 - bandBps);
  const upper = applyBps(anchorUsd, 10_000 + bandBps);
  if (compareDecimals(priceUsd, lower) < 0) return lower;
  if (compareDecimals(priceUsd, upper) > 0) return upper;
  return priceUsd;
}

/** Exact decimal comparison via scaled BigInt math (same discipline as
 * applyBps — no floating point). */
function compareDecimals(a: string, b: string): number {
  const pa = decimalParts(a);
  const pb = decimalParts(b);
  const left = pa.mantissa * pb.scale;
  const right = pb.mantissa * pa.scale;
  return left < right ? -1 : left > right ? 1 : 0;
}

function decimalParts(value: string): { mantissa: bigint; scale: bigint } {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new Error(`Expected a decimal string, got ${value}`);
  const mantissa = BigInt(
    `${match[1] === "-" ? "-" : ""}${match[2]}${match[3] ?? ""}`,
  );
  return { mantissa, scale: 10n ** BigInt((match[3] ?? "").length) };
}

/** Fee tiers arrive sorted ascending by level; the base tier is level 0
 * (volume_threshold 0 — the most expensive, conservative tier). When no
 * tier carries a numeric level, the first row is the base. */
function selectBaseFeeTier(tiers: unknown[]): Record<string, unknown> {
  let base: Record<string, unknown> | undefined;
  let lowestLevel = Number.POSITIVE_INFINITY;
  for (const tier of tiers) {
    if (!isRecord(tier)) continue;
    const level = tier.level;
    if (typeof level !== "number" || !Number.isFinite(level)) continue;
    if (level < lowestLevel) {
      lowestLevel = level;
      base = tier;
    }
    if (level === 0) return tier;
  }
  if (base) return base;
  const first = tiers[0];
  if (isRecord(first)) return first;
  throw new Error("Arcus GET /v1/feetiers returned no usable fee tier records");
}

/** A fee tier's ppm field as a normalized decimal string, else undefined.
 * Accepts both snake_case (doc shape) and camelCase payload variants. */
function findFeePpm(
  tier: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const entry = tier[key];
    if (typeof entry !== "string" && typeof entry !== "number") continue;
    const asString = String(entry).trim();
    if (/^-?\d+(\.\d+)?$/.test(asString)) return asString;
  }
  return undefined;
}

/** ppm → bps with exact integer math: bps = ppm / 100, built from scaled
 * BigInt parts so 150 → "1.5", 205 → "2.05", 200 → "2", -50 → "-0.5", 0 →
 * "0" — no floating point formatting drift, negatives (maker rebates)
 * preserved. */
function ppmToBps(ppm: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(ppm);
  if (!match) throw new Error(`Expected a ppm decimal string, got ${ppm}`);
  const mantissa = BigInt(`${match[2]}${match[3] ?? ""}`);
  if (mantissa === 0n) return "0";
  const denominator = 10n ** BigInt((match[3] ?? "").length) * 100n;
  const integer = mantissa / denominator;
  let remainder = mantissa % denominator;
  let fraction = "";
  while (remainder !== 0n && fraction.length < 40) {
    remainder *= 10n;
    fraction += (remainder / denominator).toString(10);
    remainder %= denominator;
  }
  const digits =
    fraction === ""
      ? integer.toString(10)
      : `${integer.toString(10)}.${fraction.replace(/0+$/, "")}`;
  return match[1] === "-" ? `-${digits}` : digits;
}

/** GET /v1/order/{orderId} may wrap the record in an envelope; unwrap the
 * usual suspects, otherwise use the payload as-is. */
function unwrapOrderRecord(payload: unknown): Record<string, unknown> {
  if (isRecord(payload)) {
    for (const key of ["order", "data", "result"]) {
      const inner = payload[key];
      if (isRecord(inner)) return inner;
    }
    return payload;
  }
  throw new Error("Arcus order response was not an object");
}

function findPositionRecord(
  positions: Record<string, unknown>,
  marketId: string,
): Record<string, unknown> | undefined {
  const direct = positions[marketId];
  if (isRecord(direct)) return direct;
  // The map is keyed by stringified numeric marketId; if the filtered
  // response carries exactly one entry, use it.
  const records = Object.values(positions).filter(isRecord);
  if (records.length === 1) return records[0];
  return undefined;
}

/** A decimal strictly greater than zero, else undefined (Arcus reports
 * unfilled TP/SL orders as avgFillPrice "0", which must not read as an
 * exit price). */
function positiveDecimal(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? value : undefined;
}

/** Cumulative close-fill size reaching the leg quantity — exact decimal
 * comparison first, then the CLOSURE_QTY_EPSILON band for venue-reported
 * sizes that land a hair under (rounding). */
function closureQtyReached(cumulative: string, target: string): boolean {
  if (compareDecimals(cumulative, target) >= 0) return true;
  return (
    compareDecimals(subtractDecimalStrings(target, cumulative), CLOSURE_QTY_EPSILON) <= 0
  );
}

/** Exact decimal addition of two string operands via scaled BigInt parts —
 * no floating point, same discipline as applyBps/compareDecimals. */
function addDecimalStrings(a: string, b: string): string {
  const pa = decimalParts(a);
  const pb = decimalParts(b);
  return formatScaledDecimal(
    pa.mantissa * pb.scale + pb.mantissa * pa.scale,
    pa.scale * pb.scale,
  );
}

/** Exact decimal subtraction (a − b) via scaled BigInt parts. */
function subtractDecimalStrings(a: string, b: string): string {
  const pb = decimalParts(b);
  return addDecimalStrings(a, formatScaledDecimal(-pb.mantissa, pb.scale));
}

/** Exact decimal product of two string operands (scaled BigInt). */
function mulDecimalStrings(a: string, b: string): string {
  const pa = decimalParts(a);
  const pb = decimalParts(b);
  return formatScaledDecimal(pa.mantissa * pb.mantissa, pa.scale * pb.scale);
}

/** Exact decimal division (numerator ÷ denominator) with long division —
 * the VWAP over the accepted close fills. No floating point; a zero
 * denominator throws (cumulative is only ever positive here). */
function divideScaledDecimal(numerator: string, denominator: string): string {
  const n = decimalParts(numerator);
  const d = decimalParts(denominator);
  if (d.mantissa === 0n) throw new Error("division by zero decimal");
  const negative = (n.mantissa < 0n) !== (d.mantissa < 0n);
  let remainder = (n.mantissa < 0n ? -n.mantissa : n.mantissa) * d.scale;
  const divisor = (d.mantissa < 0n ? -d.mantissa : d.mantissa) * n.scale;
  const integer = remainder / divisor;
  remainder %= divisor;
  if (remainder === 0n)
    return negative ? `-${integer.toString(10)}` : integer.toString(10);
  let fraction = "";
  while (remainder !== 0n && fraction.length < 40) {
    remainder *= 10n;
    fraction += (remainder / divisor).toString(10);
    remainder %= divisor;
  }
  return negative
    ? `-${integer.toString(10)}.${fraction.replace(/0+$/, "")}`
    : `${integer.toString(10)}.${fraction.replace(/0+$/, "")}`;
}

/** Normalize scaled BigInt parts back into a trimmed decimal string
 * (trailing zeros stripped; negatives preserved). */
function formatScaledDecimal(mantissa: bigint, scale: bigint): string {
  if (mantissa === 0n) return "0";
  const negative = mantissa < 0n;
  const abs = negative ? -mantissa : mantissa;
  const integer = abs / scale;
  const remainder = abs % scale;
  if (remainder === 0n)
    return negative ? `-${integer.toString(10)}` : integer.toString(10);
  const width = scale.toString(10).length - 1;
  const fraction = remainder
    .toString(10)
    .padStart(width, "0")
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${integer.toString(10)}.${fraction}`;
}

function requiredRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is missing or invalid`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== ""
    ? value
    : typeof value === "number"
      ? String(value)
      : undefined;
}

function decimalField(record: unknown, keys: string[], label: string): string {
  const source = requiredRecord(record, label);
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" || typeof value === "number") {
      const asString = String(value);
      if (/^-?\d+(\.\d+)?$/.test(asString)) return asString;
    }
  }
  throw new Error(`${label} is missing or invalid`);
}

function findDecimal(value: unknown, keys: string[]): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const entry = value[key];
    if (
      (typeof entry === "string" || typeof entry === "number") &&
      /^-?\d+(\.\d+)?$/.test(String(entry))
    )
      return String(entry);
  }
  return undefined;
}

/** Exact basis-point scaling with BigInt rational math — no floating point
 * (same approach as the Extended execution adapter). */
function applyBps(value: string, bps: number): string {
  const [intPart, fracPart = ""] = value.split(".");
  const scale = 10n ** BigInt(fracPart.length);
  const numerator = BigInt(`${intPart}${fracPart}`) * BigInt(bps);
  const denominator = scale * 10_000n;
  const integer = numerator / denominator;
  let remainder = numerator % denominator;
  if (remainder === 0n) return integer.toString(10);
  let fraction = "";
  while (remainder !== 0n && fraction.length < 40) {
    remainder *= 10n;
    fraction += (remainder / denominator).toString(10);
    remainder %= denominator;
  }
  return `${integer.toString(10)}.${fraction.replace(/0+$/, "")}`;
}

function fail(message: string): never {
  throw new Error(message);
}
