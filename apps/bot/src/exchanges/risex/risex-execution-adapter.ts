import { formatDecimal, parseDecimal } from "@btc-arbitrage/domain";
import type {
  BestBidOffer,
  ExecutionAdapter,
  ExecutionOrder,
  ExecutionOrderRequest,
  ExchangePosition,
  MarketMetadata,
  PriceRequest,
} from "@btc-arbitrage/exchange-core";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import {
  asArrayPayload,
  findMarket,
  getMarketId,
} from "../market-normalization.js";
import { ExchangeClient } from "./sdk/ExchangeClient.js";
import { createNonce } from "./sdk/signing/nonce.js";
import {
  OrderType,
  Side,
  StpMode,
  StopPriceOption,
  TimeInForce,
} from "./sdk/types/common.js";
import type { RisexConfig } from "./risex.types.js";

// RISEx places orders via a signed on-chain action: the place response is an
// acknowledgment, not a fill. Confirm market fills by watching the account
// position move by the ordered quantity (no REST fill-history endpoint exists).
const MARKET_FILL_TIMEOUT_MS = 15_000;
const MARKET_FILL_POLL_MS = 300;
/** TTL for cached near-static exchange data (market info). The entry and
 * reprice paths re-fetched /v1/markets on every call; the record rotates
 * rarely, so a short TTL cache removes those round trips from the hot
 * path (same rationale as the Extended static-data cache, 2026-09-22). */
const EXCHANGE_STATIC_DATA_TTL_MS = 10 * 60 * 1000;
const PLACE_ORDER_SELECTOR = "RISE_PERPS_PLACE_ORDER_V1";
const CANCEL_ORDER_SELECTOR = "RISE_PERPS_CANCEL_ORDER_V1";
const UPDATE_LEVERAGE_SELECTOR = "RISE_PERPS_UPDATE_LEVERAGE_V1";

/** Where a market-order fill price came from. `order_ack` is the venue's own
 * acknowledgment (authoritative). `order_history` is a qty-weighted average of
 * the order's fills read back from `/v1/orders` / `/v1/trade-history`.
 * `position_average` is the whole-position `avg_entry_price` fallback (blended
 * with any residual position) — the caller must run it through the integrity
 * check before anchoring protection orders. */
type FillPriceSource = "order_ack" | "order_history" | "position_average";

interface MarketFillResult {
  priceUsd?: string;
  source: FillPriceSource;
  /** True when the price came from the signed-size/quote-amount derivation in
   * readPositionEntryPrice (a blended whole-position fallback, not a true
   * order fill). */
  derived: boolean;
  /** True once the fill itself is proven by the position delta, even when no
   * price source has the fill indexed yet. False when the deadline expired
   * before the position moved (genuinely unfilled). */
  filled: boolean;
}

type RisexSide = 0 | 1;
type RisexOrderType = 0 | 1;
type RisexTimeInForce = 0 | 1 | 2 | 3;

interface RisexExecutionHttpClient {
  get(
    path: string,
    query?: Record<string, string | undefined>,
  ): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
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

export function createRisexExecutionAdapter(
  config: RisexConfig,
  http: RisexExecutionHttpClient,
): ExecutionAdapter {
  return new RisexExecutionAdapter(config, http);
}

export class RisexExecutionAdapter implements ExecutionAdapter {
  private readonly signerAddress?: string;
  private readonly exchangeClient?: ExchangeClient;
  private exchangeClientReady?: Promise<ExchangeClient>;
  private readonly sleep: (ms: number) => Promise<void>;

  // TTL cache for getMarketInfo (see EXCHANGE_STATIC_DATA_TTL_MS).
  private readonly marketInfoCache = new Map<
    string,
    { value: RisexMarketInfo; expiresAt: number }
  >();

  constructor(
    private readonly config: RisexConfig,
    private readonly http: RisexExecutionHttpClient,
    private readonly now: () => Date = () => new Date(),
    sleep?: (ms: number) => Promise<void>,
    private readonly marketFillTimeoutMs = MARKET_FILL_TIMEOUT_MS,
  ) {
    this.sleep =
      sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.signerAddress = config.sessionSignerPrivateKey
      ? privateKeyToAddress(config.sessionSignerPrivateKey)
      : undefined;
    if (config.accountAddress && config.sessionSignerPrivateKey) {
      this.exchangeClient = new ExchangeClient(
        {
          baseUrl: config.apiBaseUrl,
          account: config.accountAddress,
          accountKey: config.accountPrivateKey,
          signerKey: config.sessionSignerPrivateKey,
        },
        http,
      );
    }
  }

  async getBestBidOffer(input: PriceRequest): Promise<BestBidOffer> {
    const info = await this.getMarketInfo(input);
    const orderbook = await this.getOrderbook(info.marketId);
    return {
      bidUsd: firstOrderbookPrice(orderbook, "bids", "RISEx best bid"),
      askUsd: firstOrderbookPrice(orderbook, "asks", "RISEx best ask"),
      receivedAt: this.now(),
    };
  }

  async getMarketMetadata(input: PriceRequest): Promise<MarketMetadata> {
    const info = await this.getMarketInfo(input);
    return {
      minQuantityBase: info.minQuantityBase,
      quantityStepBase: info.quantityStepBase,
      priceTickUsd: info.priceStepUsd,
      maxLeverage: info.maxLeverage,
      positionMode: "one-way",
    };
  }

  async getAvailableMarginUsd(): Promise<string> {
    const account = this.requireAccountAddress();
    const payload = await this.http.get("/v1/account/cross-margin-balance", {
      account,
    });
    const body = unwrapData(payload);
    return requireDecimalDeep(
      body,
      [
        "available_balance",
        "availableBalance",
        "available_margin",
        "availableMargin",
        "free_collateral",
        "freeCollateral",
        "cross_margin_balance",
        "crossMarginBalance",
        "balance",
        "equity",
      ],
      "RISEx available margin",
    );
  }

  async validateExecutionPreflight(input: {
    symbol: string;
    leverage: number;
  }): Promise<void> {
    this.requireTradingCredentials();
    const info = await this.getMarketInfo({
      symbol: input.symbol,
      marketType: "perpetual",
      priceSource: "last",
    });
    if (
      !Number.isInteger(input.leverage) ||
      input.leverage <= 0 ||
      input.leverage > 255
    )
      throw new Error("RISEx leverage must be an integer between 1 and 255");
    if (info.maxLeverage && input.leverage > info.maxLeverage)
      throw new Error(
        `RISEx leverage ${input.leverage} exceeds market max ${info.maxLeverage}`,
      );
    await (await this.getExchangeClient()).updateLeverage(
      info.marketId,
      BigInt(input.leverage),
    );
  }

  async submitExecutionOrder(
    input: ExecutionOrderRequest,
  ): Promise<ExecutionOrder> {
    this.requireTradingCredentials();
    const info = await this.getMarketInfo({
      symbol: input.symbol,
      marketType: "perpetual",
      priceSource: "last",
    });
    if (input.type === "take-profit-market" || input.type === "stop-market") {
      if (!input.triggerPriceUsd)
        throw new Error("RISEx TP/SL order requires triggerPriceUsd");
      if (!input.reduceOnly)
        throw new Error("RISEx TP/SL execution orders must be reduce-only");
      const size = normalizeSignedDecimal(input.quantityBase);
      const trigger = roundDecimalToStepString(
        input.triggerPriceUsd,
        info.priceStepUsd,
        input.side === "buy" ? "up" : "down",
      );
      const limit = deriveTpslLimitPrice(
        trigger,
        info.priceStepUsd,
        input.type,
        input.side,
      );
      const response =
        input.type === "take-profit-market"
          ? await (await this.getExchangeClient()).placeTakeProfit({
              market_id: info.marketId,
              side: input.side === "buy" ? Side.Long : Side.Short,
              size,
              stop_price: trigger,
              limit_price: limit,
              stop_price_option: StopPriceOption.MarkPrice,
              tif: TimeInForce.GoodTillCancelled,
            })
          : await (await this.getExchangeClient()).placeStopLoss({
              market_id: info.marketId,
              side: input.side === "buy" ? Side.Long : Side.Short,
              size,
              stop_price: trigger,
              limit_price: limit,
              stop_price_option: StopPriceOption.MarkPrice,
              tif: TimeInForce.GoodTillCancelled,
            });
      const id = stringField(
        firstRecord(unwrapData(response)) ??
          (response as Record<string, unknown>),
        ["order_id", "orderId", "id"],
      );
      if (!id) throw new Error("RISEx TPSL response did not include order_id");
      return { id, status: "new", filledQuantityBase: "0" };
    }

    const orderType: RisexOrderType = input.type === "market" ? 0 : 1;
    const timeInForce: RisexTimeInForce = input.type === "market" ? 3 : 0;
    const side: RisexSide = input.side === "sell" ? 1 : 0;
    const sizeSteps = decimalToIntegerUnits(
      input.quantityBase,
      info.quantityStepBase,
      "RISEx quantity",
    );
    const priceUsd = input.priceUsd ?? (await this.getMarketPriceBound(input));
    const priceTicks = priceToTicks(
      priceUsd,
      info.priceStepUsd,
      input.side,
      input.type,
    );
    const postOnly = input.type === "limit";
    const reduceOnly = input.reduceOnly === true;
    const marketFillWatch =
      input.type === "market"
        ? { baseline: await this.readSignedPositionQuantity(info.marketId) }
        : undefined;

    const response = await (await this.getExchangeClient()).placeOrder({
      market_id: info.marketId,
      size_steps: Number(sizeSteps),
      price_ticks: Number(priceTicks),
      side: side === 0 ? Side.Long : Side.Short,
      post_only: postOnly,
      reduce_only: reduceOnly,
      stp_mode: StpMode.ExpireMaker,
      order_type: orderType === 0 ? OrderType.Market : OrderType.Limit,
      time_in_force:
        timeInForce === 3
          ? TimeInForce.ImmediateOrCancel
          : TimeInForce.GoodTillCancelled,
      ttl_units: 0,
      client_order_id: normalizeClientOrderId(
        input.clientOrderId,
        this.requireAccountAddress(),
      ),
    });

    const submitted = normalizeSubmittedOrder(response, info);
    if (input.type === "market") {
      const ack = firstRecord(unwrapData(response));
      console.log("RISEx market order acknowledgment", {
        orderId: submitted.id,
        status: submitted.status,
        filledQuantityBase: submitted.filledQuantityBase,
        averageFillPriceUsd: submitted.averageFillPriceUsd,
        ackKeys: ack ? Object.keys(ack).join(",") : undefined,
      });
    }
    if (input.type !== "market" || !marketFillWatch) return submitted;
    if (submitted.status === "filled" && submitted.averageFillPriceUsd)
      return withFillProvenance(submitted, "order_ack", false);
    const fill = await this.waitForMarketFill({
      marketId: info.marketId,
      orderId: submitted.id,
      side: input.side,
      quantityBase: input.quantityBase,
      quantityStepBase: info.quantityStepBase,
      baseline: marketFillWatch.baseline,
    });
    if (!fill.filled) return submitted;
    if (fill.priceUsd === undefined) {
      // The fill is proven by the position delta, but no price source
      // indexed it within the deadline. Report the fill truthfully (the
      // stale ack must not read as "not filled" upstream — that false
      // negative triggered a rollback of a fully-filled hedge on
      // 2026-09-18). Price resolution is left to the caller's re-poll.
      return {
        ...submitted,
        status: "filled",
        filledQuantityBase: input.quantityBase,
      };
    }
    return withFillProvenance(
      {
        ...submitted,
        status: "filled",
        filledQuantityBase: input.quantityBase,
        averageFillPriceUsd: fill.priceUsd,
      },
      fill.source,
      fill.derived,
    );
  }

  async getExecutionOrder(orderId: string): Promise<ExecutionOrder> {
    const order = await this.requireOpenOrder(orderId);
    return normalizeOpenOrder(order, undefined);
  }

  async cancelExecutionOrder(orderId: string): Promise<void> {
    this.requireTradingCredentials();
    const order = await this.requireOpenOrder(orderId);
    await (await this.getExchangeClient()).cancelOrder({
      market_id: order.marketId,
      order_id: order.id,
      resting_order_id: order.restingOrderId.toString(),
    });
  }

  async getPosition(input: {
    symbol: string;
    side: "long" | "short";
  }): Promise<ExchangePosition | null> {
    const account = this.requireAccountAddress();
    const info = await this.getMarketInfo({
      symbol: input.symbol,
      marketType: "perpetual",
      priceSource: "last",
    });
    const payload = await this.http.get("/v1/account/position", {
      account,
      market_id: String(info.marketId),
    });
    const body = firstRecord(unwrapData(payload));
    if (!body)
      return {
        side: input.side,
        quantityBase: "0",
        status: "closed",
        closeReason: "unknown",
      };
    const id = stringField(body, ["id", "position_id", "positionId"]);
    const extras: Pick<ExchangePosition, "exitPriceUsd" | "realizedPnlUsd"> = {
      exitPriceUsd: optionalDecimalDeep(body, [
        "close_price",
        "exit_price",
        "exitPrice",
        "closePrice",
      ]),
      realizedPnlUsd: optionalDecimalDeep(body, [
        "realized_pnl",
        "realizedPnl",
        "pnl",
        "realized_pnl_usd",
        "realizedPnlUsd",
      ]),
    };
    const signedQuantity = optionalSignedDecimalDeep(body, [
      "quantity",
      "quantity_base",
      "quantityBase",
      "size",
      "size_base",
      "sizeBase",
      "position_size",
      "positionSize",
    ]);
    if (!signedQuantity || parseDecimal(signedQuantity) === 0)
      return {
        id,
        side: input.side,
        quantityBase: "0",
        status: "closed",
        closeReason: normalizeCloseReason(body),
        ...extras,
      };
    const quantity = parseDecimal(signedQuantity);
    const actualSide = quantity < 0 ? "short" : "long";
    if (actualSide !== input.side)
      return {
        id,
        side: input.side,
        quantityBase: "0",
        status: "closed",
        closeReason: "unknown",
        ...extras,
      };
    return {
      id,
      side: actualSide,
      quantityBase: formatDecimal(Math.abs(quantity), 10),
      entryPriceUsd: optionalDecimalDeep(body, [
        "entry_price",
        "entryPrice",
        "avg_entry_price",
        "averageEntryPrice",
      ]),
      status: "open",
    };
  }

  async getOpenOrders(input?: { symbol?: string }): Promise<RisexOpenOrder[]> {
    const account = this.requireAccountAddress();
    let marketId: string | undefined;
    if (input?.symbol) {
      const info = await this.getMarketInfo({
        symbol: input.symbol,
        marketType: "perpetual",
        priceSource: "last",
      });
      marketId = String(info.marketId);
    }
    const payload = await this.http.get("/v1/orders/open", {
      account,
      market_id: marketId,
    });
    return asRisexArrayPayload(payload)
      .filter(isRecord)
      .map(normalizeRawOpenOrder);
  }

  async getOpenTpslOrders(input?: { symbol?: string }): Promise<unknown[]> {
    const account = this.requireAccountAddress();
    let marketId: string | undefined;
    if (input?.symbol) {
      const info = await this.getMarketInfo({
        symbol: input.symbol,
        marketType: "perpetual",
        priceSource: "last",
      });
      marketId = String(info.marketId);
    }
    const payload = await this.http.get("/v1/orders/tpsl", {
      account,
      market_id: marketId,
    });
    return asRisexArrayPayload(payload);
  }

  private async readSignedPositionQuantity(marketId: number): Promise<number> {
    const account = this.requireAccountAddress();
    const payload = await this.http.get("/v1/account/position", {
      account,
      market_id: String(marketId),
    });
    const body = firstRecord(unwrapData(payload));
    if (!body) return 0;
    const signed = optionalSignedDecimalDeep(body, [
      "quantity",
      "quantity_base",
      "quantityBase",
      "size",
      "size_base",
      "sizeBase",
      "position_size",
      "positionSize",
    ]);
    return signed ? parseDecimal(signed) : 0;
  }

  private async waitForMarketFill(input: {
    marketId: number;
    orderId: string;
    side: "buy" | "sell";
    quantityBase: string;
    quantityStepBase: string;
    baseline: number;
  }): Promise<MarketFillResult> {
    const targetDelta = parseDecimal(input.quantityBase);
    const tolerance = Math.max(parseDecimal(input.quantityStepBase) / 2, 1e-10);
    const direction = input.side === "buy" ? 1 : -1;
    const deadline = this.now().getTime() + this.marketFillTimeoutMs;
    let pollCount = 0;
    for (;;) {
      pollCount += 1;
      const signed = await this.readSignedPositionQuantity(input.marketId);
      const delta = direction * (signed - input.baseline);
      console.log("RISEx market fill poll", {
        marketId: input.marketId,
        poll: pollCount,
        side: input.side,
        baseline: input.baseline,
        signed,
        delta,
        targetDelta,
      });
      if (delta >= targetDelta - tolerance) {
        // Prefer the order's own fill data over the whole-position average
        // (which blends with any residual position). Fall back to the
        // position average only when the order-level read yields nothing.
        const orderFill = await this.readOrderHistoryFillPrice(
          input.orderId,
          input.marketId,
        );
        if (orderFill.priceUsd !== undefined) return orderFill;
        const position = await this.readPositionEntryPrice(input.marketId);
        if (position.priceUsd !== undefined) {
          // The quote/size derivation is exact (this order's own fill price)
          // only when the position consists solely of this fill: flat at
          // baseline and the observed size matches baseline + delta. Any
          // residual or unexpected size means the derivation blends other
          // fills and must stay flagged, so the caller's D2 integrity check
          // rejects it instead of anchoring a blended price (2026-09-18:
          // a flat-baseline fill with 0.0 bps deviation was falsely flagged
          // derived and the orchestrator rolled back a healthy trade).
          const blended =
            Math.abs(input.baseline) > tolerance ||
            Math.abs(
              Math.abs(signed) - (Math.abs(input.baseline) + targetDelta),
            ) > tolerance;
          console.log("RISEx market fill detected", {
            marketId: input.marketId,
            polls: pollCount,
            entryPriceUsd: position.priceUsd,
            source: "position_average",
            derived: blended,
          });
          return {
            priceUsd: position.priceUsd,
            source: "position_average",
            derived: blended,
            filled: true,
          };
        }
        // The fill is proven by the position delta, but no price source has
        // it indexed yet (read-after-write lag on /v1/orders, /v1/trade-
        // history, and the position snapshot). Returning "filled but price
        // unknown" upstream once triggered a false "Market hedge was not
        // immediately filled" rollback of a fully-filled hedge (2026-09-18),
        // so keep polling the history endpoints until the deadline instead.
        if (this.now().getTime() >= deadline) {
          console.warn("RISEx market fill price unresolved at deadline", {
            marketId: input.marketId,
            polls: pollCount,
            orderId: input.orderId,
          });
          return { source: "position_average", derived: false, filled: true };
        }
        console.warn("RISEx market fill price not yet indexed; retrying", {
          marketId: input.marketId,
          polls: pollCount,
          orderId: input.orderId,
        });
        await this.sleep(MARKET_FILL_POLL_MS);
        continue;
      }
      if (this.now().getTime() >= deadline) {
        console.warn("RISEx market fill timed out", {
          marketId: input.marketId,
          polls: pollCount,
          baseline: input.baseline,
          lastSigned: signed,
          timeoutMs: this.marketFillTimeoutMs,
        });
        return { source: "position_average", derived: false, filled: false };
      }
      await this.sleep(MARKET_FILL_POLL_MS);
    }
  }

  /** Reads the order's own fills back from the account order endpoints:
   * first `/v1/orders` history by order id (average-fill field when
   * present), then a quantity-weighted average of the order's per-fill
   * prices from `/v1/trade-history`. Read failures degrade to "no data"
   * so the caller can fall back to the position average. */
  private async readOrderHistoryFillPrice(
    orderId: string,
    marketId: number,
  ): Promise<MarketFillResult> {
    const account = this.requireAccountAddress();
    try {
      const historyPayload = await this.http.get("/v1/orders", {
        account,
        market_id: String(marketId),
        limit: "50",
      });
      const history = asRisexArrayPayload(historyPayload).filter(isRecord);
      const entry = history.find(
        (candidate) =>
          stringField(candidate, ["order_id", "orderId", "id"]) === orderId ||
          normalizeHex(
            stringField(candidate, ["order_id", "orderId", "id"]) ?? "",
          ) === normalizeHex(orderId),
      );
      if (entry) {
        const average = optionalDecimalDeep(entry, [
          "average_fill_price",
          "averageFillPrice",
          "avg_fill_price",
          "avgFillPrice",
        ]);
        if (average) {
          console.log("RISEx order history average fill price", {
            orderId,
            averageFillPriceUsd: average,
          });
          return {
            priceUsd: average,
            source: "order_history",
            derived: false,
            filled: true,
          };
        }
      }
    } catch (error) {
      console.warn("RISEx order history read failed; trying trade history", {
        orderId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      const fillsPayload = await this.http.get("/v1/trade-history", {
        account,
        market_id: String(marketId),
        limit: "50",
      });
      const fills = asRisexArrayPayload(fillsPayload)
        .filter(isRecord)
        .filter(
          (fill) =>
            stringField(fill, ["order_id", "orderId"]) === orderId ||
            normalizeHex(stringField(fill, ["order_id", "orderId"]) ?? "") ===
              normalizeHex(orderId),
        );
      let notional = 0;
      let size = 0;
      for (const fill of fills) {
        const fillSize = optionalDecimalDeep(fill, ["size", "filled_size"]);
        const fillPrice = optionalDecimalDeep(fill, ["price", "price_usd"]);
        if (!fillSize || !fillPrice) continue;
        notional += parseDecimal(fillSize) * parseDecimal(fillPrice);
        size += parseDecimal(fillSize);
      }
      if (size > 0) {
        const average = formatDecimal(notional / size, 8);
        console.log("RISEx trade history weighted fill price", {
          orderId,
          fills: fills.length,
          averageFillPriceUsd: average,
        });
        return {
          priceUsd: average,
          source: "order_history",
          derived: false,
          filled: true,
        };
      }
    } catch (error) {
      console.warn("RISEx trade history read failed", {
        orderId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    // No order-level fill data available yet; the caller falls back to the
    // position average and retry loops. `filled` stays false here because
    // this return carries no fill evidence of its own.
    return { source: "position_average", derived: false, filled: false };
  }

  private async readPositionEntryPrice(
    marketId: number,
  ): Promise<{ priceUsd?: string; derived: boolean }> {
    const account = this.requireAccountAddress();
    const payload = await this.http.get("/v1/account/position", {
      account,
      market_id: String(marketId),
    });
    const body = firstRecord(unwrapData(payload));
    if (!body) return { derived: false };
    // 2026-09-18: the endpoint wraps the record in a "position" envelope
    // (positionKeys: "position"); unwrap it before extracting fields.
    const record = nestedRecord(body, "position") ?? body;
    const explicit = optionalDecimalDeep(record, [
      "entry_price",
      "entryPrice",
      "avg_entry_price",
      "averageEntryPrice",
    ]);
    if (explicit) {
      console.log("RISEx position entry price (explicit field)", {
        marketId,
        entryPriceUsd: explicit,
      });
      return { priceUsd: explicit, derived: false };
    }
    // Some RISEx position payloads report avg_entry_price: "" even on an open
    // position (observed 2026-09-14 right after a market fill). Derive the
    // average entry from position notional instead: quote_amount / |size|.
    // NOTE: size must be read with the SIGNED deep helper — a short position
    // reports size "-0.00384", which primitiveDecimal (unsigned regex)
    // rejects; that silently killed this fallback on 2026-09-14.
    const size = optionalSignedDecimalDeep(record, [
      "size",
      "position_size",
      "positionSize",
      "quantity",
    ]);
    const quote = optionalDecimalDeep(record, [
      "quote_amount",
      "quoteAmount",
      "notional",
      "position_notional",
      "positionNotional",
    ]);
    if (!size || !quote) {
      console.warn("RISEx position entry price unavailable", {
        marketId,
        positionKeys: Object.keys(record).join(","),
      });
      return { derived: false };
    }
    const sizeNumber = parseDecimal(size);
    if (sizeNumber === 0) return { derived: false };
    const derived = formatDecimal(
      parseDecimal(quote) / Math.abs(sizeNumber),
      8,
    );
    console.log("RISEx position entry price (derived quote/size)", {
      marketId,
      size,
      quoteAmount: quote,
      entryPriceUsd: derived,
    });
    return { priceUsd: derived, derived: true };
  }

  private async getMarketPriceBound(
    input: ExecutionOrderRequest,
  ): Promise<string> {
    const bbo = await this.getBestBidOffer({
      symbol: input.symbol,
      marketType: "perpetual",
      priceSource: "last",
    });
    return input.side === "buy" ? bbo.askUsd : bbo.bidUsd;
  }

  private async getMarketInfo(input: PriceRequest): Promise<RisexMarketInfo> {
    const cacheKey = `${input.symbol}|${input.marketType}`;
    const cached = this.marketInfoCache.get(cacheKey);
    if (cached && cached.expiresAt > this.now().getTime()) return cached.value;
    const payload = await this.http.get("/v1/markets");
    const market = findMarket(payload, input.symbol, input.marketType);
    const config = nestedRecord(market, "config");
    const minQuantityBase = requireDecimalFromRecords(
      [config, market],
      ["min_order_size", "minOrderSize", "min_size", "minSize"],
      "RISEx min order size",
    );
    const quantityStepBase = requireDecimalFromRecords(
      [config, market],
      ["step_size", "stepSize", "quantity_step", "quantityStep"],
      "RISEx quantity step",
    );
    const priceStepUsd = requireDecimalFromRecords(
      [config, market],
      [
        "step_price",
        "stepPrice",
        "tick_size",
        "tickSize",
        "price_step",
        "priceStep",
      ],
      "RISEx price step",
    );
    const info: RisexMarketInfo = {
      market,
      marketId: parseMarketId(getMarketId(market)),
      minQuantityBase,
      quantityStepBase,
      priceStepUsd,
      maxLeverage: optionalIntegerFromRecords(
        [config, market],
        ["max_leverage", "maxLeverage"],
      ),
    };
    this.marketInfoCache.set(cacheKey, {
      value: info,
      expiresAt: this.now().getTime() + EXCHANGE_STATIC_DATA_TTL_MS,
    });
    return info;
  }

  private async getOrderbook(
    marketId: number,
  ): Promise<Record<string, unknown>> {
    const payload = await this.http.get("/v1/orderbook", {
      market_id: String(marketId),
      limit: "1",
    });
    const body = unwrapData(payload);
    if (!isRecord(body))
      throw new Error("RISEx orderbook response was not an object");
    return body;
  }

  private async requireOpenOrder(orderId: string): Promise<RisexOpenOrder> {
    const order = (await this.getOpenOrders()).find(
      (candidate) =>
        candidate.id === orderId ||
        normalizeHex(candidate.id) === normalizeHex(orderId),
    );
    if (!order)
      throw new Error(
        `RISEx open order ${orderId} was not found; fill history is not documented, so status cannot be inferred safely`,
      );
    return order;
  }

  private requireAccountAddress(): string {
    if (!this.config.accountAddress)
      throw new Error(
        "RISEX_ACCOUNT_ADDRESS is required for RISEx account-scoped reads",
      );
    return normalizeAddress(this.config.accountAddress);
  }

  private requireTradingCredentials(): void {
    if (!this.config.tradingEnabled)
      throw new Error(
        "RISEx live execution is disabled; set RISEX_TRADING_ENABLED=true to allow signed REST mutations",
      );
    this.requireAccountAddress();
    if (!this.config.sessionSignerPrivateKey || !this.signerAddress)
      throw new Error(
        "RISEX_SESSION_SIGNER_PRIVATE_KEY is required for RISEx signed REST mutations",
      );
  }

  private async getExchangeClient(): Promise<ExchangeClient> {
    this.requireTradingCredentials();
    if (!this.exchangeClient)
      throw new Error("RISEx exchange client could not be initialized");
    if (!this.exchangeClientReady) {
      this.exchangeClientReady = this.exchangeClient.init().catch((error) => {
        this.exchangeClientReady = undefined;
        throw error;
      });
    }
    return this.exchangeClientReady;
  }
}

export function createRisexPlaceOrderActionHash(input: {
  marketId: number;
  sizeSteps: bigint;
  priceTicks: bigint;
  side: RisexSide;
  postOnly: boolean;
  reduceOnly: boolean;
  stpMode: number;
  orderType: RisexOrderType;
  timeInForce: RisexTimeInForce;
}): Uint8Array {
  const orderData = packRisexOrderData(input);
  return keccakBytes(
    concatBytes(
      selectorHash(PLACE_ORDER_SELECTOR),
      abiWord(0x01),
      abiWord(orderData),
      abiWord(0),
      abiWord(0),
      abiWord(0),
    ),
  );
}

export function createRisexCancelOrderActionHash(input: {
  marketId: number;
  restingOrderId: bigint;
}): Uint8Array {
  return keccakBytes(
    concatBytes(
      selectorHash(CANCEL_ORDER_SELECTOR),
      abiWord(input.marketId),
      abiWord(input.restingOrderId),
    ),
  );
}

export function createRisexUpdateLeverageActionHash(input: {
  marketId: number;
  leverage: number;
}): Uint8Array {
  return keccakBytes(
    concatBytes(
      selectorHash(UPDATE_LEVERAGE_SELECTOR),
      abiWord(input.marketId),
      abiWord(input.leverage),
    ),
  );
}

export function packRisexOrderData(input: {
  marketId: number;
  sizeSteps: bigint;
  priceTicks: bigint;
  side: RisexSide;
  postOnly: boolean;
  reduceOnly: boolean;
  stpMode: number;
  orderType: RisexOrderType;
  timeInForce: RisexTimeInForce;
}): bigint {
  assertUint(input.marketId, 16, "marketId");
  assertUint(input.sizeSteps, 32, "sizeSteps");
  assertUint(input.priceTicks, 24, "priceTicks");
  assertUint(input.stpMode, 2, "stpMode");
  const flags = BigInt(
    (input.side & 1) |
      (input.postOnly ? 1 << 1 : 0) |
      (input.reduceOnly ? 1 << 2 : 0) |
      ((input.stpMode & 3) << 3) |
      ((input.orderType & 1) << 5) |
      ((input.timeInForce & 3) << 6),
  );
  return (
    (BigInt(input.marketId) << 70n) |
    (input.sizeSteps << 38n) |
    (input.priceTicks << 14n) |
    (flags << 6n) |
    (1n << 1n)
  );
}

function withFillProvenance(
  order: ExecutionOrder,
  source: FillPriceSource,
  derived: boolean,
): ExecutionOrder {
  return {
    ...order,
    fillPriceSource: source,
    fillPriceDerived: derived,
  } as ExecutionOrder;
}

function normalizeSubmittedOrder(
  payload: unknown,
  info: RisexMarketInfo,
): ExecutionOrder {
  const body = firstRecord(unwrapData(payload));
  if (!body)
    throw new Error(
      "RISEx place order response did not include an order object",
    );
  const id = stringField(body, ["order_id", "orderId", "id"]);
  if (!id)
    throw new Error("RISEx place order response did not include order_id");
  const averageFillPriceUsd =
    optionalDecimalDeep(body, [
      "average_fill_price",
      "averageFillPrice",
      "avg_fill_price",
      "avgFillPrice",
      "fill_price",
      "fillPrice",
    ]) ??
    (isFilledStatus(body)
      ? optionalDecimalDeep(body, ["price", "price_usd", "priceUsd"])
      : undefined);
  return removeUndefined({
    id,
    status: normalizeOrderStatus(
      stringField(body, ["status", "order_status", "orderStatus"]) ?? "new",
    ),
    filledQuantityBase:
      normalizeFilledQuantity(body, info) ??
      optionalDecimalDeep(body, [
        "filled_quantity",
        "filledQuantity",
        "filled_size",
        "filledSize",
      ]) ??
      "0",
    averageFillPriceUsd,
  });
}

function normalizeOpenOrder(
  order: RisexOpenOrder,
  info: RisexMarketInfo | undefined,
): ExecutionOrder {
  return {
    id: order.id,
    status: normalizeOrderStatus(order.status ?? "new"),
    filledQuantityBase:
      order.filledSizeSteps !== undefined && info
        ? formatDecimal(
            Number(order.filledSizeSteps) * parseDecimal(info.quantityStepBase),
            10,
          )
        : "0",
    averageFillPriceUsd: order.averageFillPriceUsd,
  };
}

function normalizeRawOpenOrder(
  record: Record<string, unknown>,
): RisexOpenOrder {
  const id = stringField(record, ["order_id", "orderId", "id"]);
  if (!id) throw new Error("RISEx open order did not include order_id");
  const marketId = parseMarketId(
    stringField(record, ["market_id", "marketId"]) ??
      record.market_id ??
      record.marketId,
  );
  return {
    id,
    marketId,
    restingOrderId: extractRestingOrderId(record),
    sizeSteps: optionalBigInt(record, ["size_steps", "sizeSteps"]),
    remainingSizeSteps: optionalBigInt(record, [
      "remaining_size_steps",
      "remainingSizeSteps",
    ]),
    filledSizeSteps: optionalBigInt(record, [
      "filled_size_steps",
      "filledSizeSteps",
    ]),
    priceTicks: optionalBigInt(record, ["price_ticks", "priceTicks"]),
    status: stringField(record, ["status", "order_status", "orderStatus"]),
    averageFillPriceUsd: optionalDecimalDeep(record, [
      "average_fill_price",
      "averageFillPrice",
      "avg_fill_price",
      "avgFillPrice",
    ]),
    raw: record,
  };
}

function normalizeFilledQuantity(
  record: Record<string, unknown>,
  info: RisexMarketInfo,
): string | undefined {
  const filledSteps = optionalBigInt(record, [
    "filled_size_steps",
    "filledSizeSteps",
  ]);
  if (filledSteps === undefined) return undefined;
  return formatDecimal(
    Number(filledSteps) * parseDecimal(info.quantityStepBase),
    10,
  );
}

function isFilledStatus(record: Record<string, unknown>): boolean {
  if (
    normalizeOrderStatus(
      stringField(record, ["status", "order_status", "orderStatus"]) ?? "",
    ) === "filled"
  )
    return true;
  // The place-order acknowledgment for a market order may omit the status
  // field entirely and instead report the fill via filled_percent / message
  // (observed 2026-09-14: "Order fully filled", filled_percent "100.00").
  const percent = optionalDecimalDeep(record, [
    "filled_percent",
    "filledPercent",
  ]);
  if (percent !== undefined && parseDecimal(percent) >= 100) return true;
  const message = stringField(record, ["message"])?.toLowerCase() ?? "";
  return message.includes("fully filled");
}

function extractRestingOrderId(record: Record<string, unknown>): bigint {
  const explicit = optionalBigInt(record, [
    "resting_order_id",
    "restingOrderId",
  ]);
  if (explicit !== undefined) return explicit;
  const wide = optionalBigInt(record, ["wide_order_id", "wideOrderId"]);
  if (wide !== undefined) return wide >> 1n;
  throw new Error(
    "RISEx open order did not include resting_order_id or wide_order_id",
  );
}

function normalizeOrderStatus(status: string): ExecutionOrder["status"] {
  const normalized = status.toLowerCase();
  if (["filled", "fully_filled", "done"].includes(normalized)) return "filled";
  if (["partially_filled", "partial", "partiallyfilled"].includes(normalized))
    return "partially_filled";
  if (["cancelled", "canceled"].includes(normalized)) return "cancelled";
  if (["rejected", "failed"].includes(normalized)) return "rejected";
  return "new";
}

function normalizeCloseReason(
  record: Record<string, unknown>,
): ExchangePosition["closeReason"] {
  const reason = stringField(record, [
    "close_reason",
    "closeReason",
    "reason",
  ])?.toLowerCase();
  if (
    reason === "tp" ||
    reason === "sl" ||
    reason === "manual" ||
    reason === "liquidation"
  )
    return reason;
  return "unknown";
}

function priceToTicks(
  value: string,
  step: string,
  side: "buy" | "sell",
  type: ExecutionOrderRequest["type"],
): bigint {
  const rounding: "floor" | "ceil" =
    type === "market"
      ? side === "buy"
        ? "ceil"
        : "floor"
      : side === "buy"
        ? "floor"
        : "ceil";
  return decimalToIntegerUnits(value, step, "RISEx price", rounding);
}

function decimalToIntegerUnits(
  value: string,
  step: string,
  field: string,
  rounding: "exact" | "floor" | "ceil" = "exact",
): bigint {
  const numerator = parseDecimalParts(value);
  const denominator = parseDecimalParts(step);
  const scale = 10n ** BigInt(Math.max(numerator.scale, denominator.scale));
  const scaledValue =
    numerator.units * (scale / 10n ** BigInt(numerator.scale));
  const scaledStep =
    denominator.units * (scale / 10n ** BigInt(denominator.scale));
  if (scaledStep <= 0n) throw new Error(`${field} step must be positive`);
  const quotient = scaledValue / scaledStep;
  const remainder = scaledValue % scaledStep;
  if (remainder === 0n) return quotient;
  if (rounding === "floor") return quotient;
  if (rounding === "ceil") return quotient + 1n;
  throw new Error(`${field} must be an exact multiple of RISEx step ${step}`);
}

function parseDecimalParts(value: string): { units: bigint; scale: number } {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed))
    throw new Error(`Invalid unsigned decimal: ${value}`);
  const [whole, fractional = ""] = trimmed.split(".");
  return { units: BigInt(`${whole}${fractional}`), scale: fractional.length };
}

function requireDecimalDeep(
  value: unknown,
  keys: string[],
  label: string,
): string {
  const found = optionalDecimalDeep(value, keys);
  if (!found) throw new Error(`${label} was not present in RISEx payload`);
  return found;
}

function optionalDecimalDeep(
  value: unknown,
  keys: string[],
  depth = 0,
): string | undefined {
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

function optionalSignedDecimalDeep(
  value: unknown,
  keys: string[],
  depth = 0,
): string | undefined {
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
    if (typeof raw === "string" && /^[-+]?\d+(\.\d+)?$/.test(raw.trim()))
      return raw;
    if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  }
  for (const item of Object.values(value)) {
    const found = optionalSignedDecimalDeep(item, keys, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function requireDecimalFromRecords(
  records: Array<Record<string, unknown> | undefined>,
  keys: string[],
  label: string,
): string {
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const value = primitiveDecimal(record[key]);
      if (value) return value;
    }
  }
  throw new Error(`${label} was not present in RISEx market payload`);
}

function firstOrderbookPrice(
  orderbook: Record<string, unknown>,
  side: "bids" | "asks",
  label: string,
): string {
  const levels = orderbook[side];
  if (!Array.isArray(levels) || levels.length === 0)
    throw new Error(`${label} was not present in RISEx orderbook payload`);
  const first = levels.find(isRecord) as Record<string, unknown> | undefined;
  const price = first ? primitiveDecimal(first.price) : undefined;
  if (!price)
    throw new Error(`${label} was not present in RISEx orderbook payload`);
  return price;
}

function optionalIntegerFromRecords(
  records: Array<Record<string, unknown> | undefined>,
  keys: string[],
): number | undefined {
  const value = optionalStringFromRecords(records, keys);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function optionalStringFromRecords(
  records: Array<Record<string, unknown> | undefined>,
  keys: string[],
): string | undefined {
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" || typeof value === "number")
        return String(value);
    }
  }
  return undefined;
}

function primitiveDecimal(value: unknown): string | undefined {
  if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim()))
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function stringField(
  record: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "bigint"
    )
      return String(value);
  }
  return undefined;
}

function optionalBigInt(
  record: Record<string, unknown>,
  keys: string[],
): bigint | undefined {
  const value = stringField(record, keys);
  if (value === undefined) return undefined;
  return parseIntegerLike(value);
}

function parseMarketId(value: unknown): number {
  const parsed = Number(typeof value === "string" ? value : String(value));
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535)
    throw new Error(`RISEx market_id must be a uint16, got ${String(value)}`);
  return parsed;
}

function parseIntegerLike(value: string): bigint {
  if (/^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value);
  if (/^\d+$/.test(value)) return BigInt(value);
  throw new Error(`Expected integer-like value, got ${value}`);
}

type JsonScalar = string | number | boolean | null;
type JsonPayload = JsonScalar | JsonPayload[] | { [key: string]: JsonPayload };

function unwrapData(payload: unknown): JsonPayload {
  let current: unknown = payload;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!isRecord(current) || !("data" in current))
      return current as JsonPayload;
    current = current.data;
  }
  return current as JsonPayload;
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

function nestedRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function removeUndefined<T extends Record<string, unknown>>(record: T): T {
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) delete record[key];
  }
  return record;
}

function selectorHash(value: string): Uint8Array {
  return keccakBytes(new TextEncoder().encode(value));
}
function keccakBytes(value: Uint8Array): Uint8Array {
  return keccak_256(value);
}

function abiWord(value: number | bigint): Uint8Array {
  const bigint = BigInt(value);
  if (bigint < 0n)
    throw new Error("Cannot ABI-encode negative unsigned integer");
  return bigintToBytes(bigint, 32);
}

function bigintToBytes(value: bigint, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let current = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    bytes[index] = Number(current & 0xffn);
    current >>= 8n;
  }
  if (current !== 0n)
    throw new Error(`Value ${value} does not fit in ${length} bytes`);
  return bytes;
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (normalized.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(normalized))
    throw new Error("Invalid hex string");
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < bytes.length; i += 1)
    bytes[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function normalizePrivateKey(privateKey: string): string {
  const value = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
  if (!/^[0-9a-fA-F]{64}$/.test(value))
    throw new Error(
      "RISEX_SESSION_SIGNER_PRIVATE_KEY must be a 32-byte hex private key",
    );
  return value;
}

function privateKeyToAddress(privateKey: string): string {
  const publicKey = secp256k1.getPublicKey(
    hexToBytes(normalizePrivateKey(privateKey)),
    false,
  );
  return `0x${bytesToHex(keccakBytes(publicKey.slice(1)).slice(-20))}`;
}

function normalizeAddress(address: string): string {
  const value = address.startsWith("0x") ? address.slice(2) : address;
  if (!/^[0-9a-fA-F]{40}$/.test(value))
    throw new Error(`Invalid Ethereum address: ${address}`);
  return `0x${value.toLowerCase()}`;
}

function normalizeHex(value: string): string {
  return value.startsWith("0x")
    ? `0x${value.slice(2).toLowerCase()}`
    : value.toLowerCase();
}

function assertUint(value: number | bigint, bits: number, label: string): void {
  const bigint = BigInt(value);
  const max = (1n << BigInt(bits)) - 1n;
  if (bigint < 0n || bigint > max)
    throw new Error(`${label} must fit uint${bits}`);
}

function normalizeClientOrderId(
  clientOrderId: string | undefined,
  account: string,
): string | undefined {
  if (!clientOrderId) return undefined;
  if (/^\d+$/.test(clientOrderId)) return clientOrderId;
  return createNonce(account);
}

function normalizeSignedDecimal(value: string): string {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed))
    throw new Error(`Invalid decimal quantity: ${value}`);
  return trimmed;
}

function roundDecimalToStepString(
  value: string,
  step: string,
  rounding: "down" | "up",
): string {
  const units = decimalToIntegerUnits(
    value,
    step,
    "RISEx price",
    rounding === "down" ? "floor" : "ceil",
  );
  return formatUnitsToDecimal(units, step);
}

function deriveTpslLimitPrice(
  stopPrice: string,
  step: string,
  type: ExecutionOrderRequest["type"],
  side: ExecutionOrderRequest["side"],
): string {
  const stopUnits = decimalToIntegerUnits(
    stopPrice,
    step,
    "RISEx TPSL stop price",
  );
  const direction =
    type === "stop-market"
      ? side === "sell"
        ? -1n
        : 1n
      : side === "sell"
        ? 1n
        : -1n;
  const limitUnits = stopUnits + direction;
  if (limitUnits <= 0n)
    throw new Error("Derived RISEx TPSL limit price must stay positive");
  return formatUnitsToDecimal(limitUnits, step);
}

function formatUnitsToDecimal(units: bigint, step: string): string {
  const { scale } = parseDecimalParts(step);
  if (scale === 0) return units.toString();
  const factor = 10n ** BigInt(scale);
  const whole = units / factor;
  const fractional = (units % factor)
    .toString()
    .padStart(scale, "0")
    .replace(/0+$/, "");
  return fractional ? `${whole}.${fractional}` : whole.toString();
}
