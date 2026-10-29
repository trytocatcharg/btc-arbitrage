import type {
  AccountFill,
  BestBidOffer,
  ExecutionAdapter,
  ExecutionOrder,
  ExecutionOrderRequest,
  ExchangePosition,
  MarketMetadata,
  PriceRequest,
} from "@btc-arbitrage/exchange-core";
import { QfexHttpClient } from "./qfex-http-client.js";
import { QfexWsClient, QfexWsError } from "./qfex-ws-client.js";
import type {
  QfexConfig,
  QfexOrderBook,
  QfexPosition,
  QfexPositionsResponse,
  QfexRefdataSymbol,
  QfexTrade,
  QfexTradesResponse,
} from "./qfex.types.js";
import { qfexSymbolFor, resolveQfexRefdata } from "./qfex-symbol.js";

/** /user/trade paginates by limit/offset with limit <= 1000; the account
 * history is small today, but the page loop is bounded anyway so an
 * exchange-side paging bug can never spin forever. */
const USER_TRADES_PAGE_LIMIT = 1000;
const USER_TRADES_MAX_PAGES = 20;

/** WS get_user_trades page size used to recover per-order fills (VWAP +
 * real fees) once an order is terminal — the same discipline as the Arcus
 * /v1/fills memoized recovery. */
const ORDER_TRADES_LIMIT = 100;

/** Near-static refdata (tick/lot sizes, leverage caps) is cached briefly;
 * any drift surfaces as a loud exchange rejection. */
const REFDATA_TTL_MS = 10 * 60 * 1000;

interface QfexHttpApi {
  get(
    path: string,
    options?: {
      private?: boolean;
      query?: Record<
        string,
        string | number | boolean | Array<string | number | boolean> | undefined
      >;
    },
  ): Promise<unknown>;
  post?(
    path: string,
    body: unknown,
    options?: {
      private?: boolean;
      query?: Record<
        string,
        string | number | boolean | Array<string | number | boolean> | undefined
      >;
    },
  ): Promise<unknown>;
}

interface QfexWsApi {
  command(
    type: string,
    params: Record<string, unknown>,
    options?: {
      correlationKey?: { clientOrderId?: string; orderId?: string };
      timeoutMs?: number;
    },
  ): Promise<unknown>;
  close(): void;
}

export function createQfexExecutionAdapter(
  config: QfexConfig,
  http?: QfexHttpApi,
  ws?: QfexWsApi,
): ExecutionAdapter {
  return new QfexExecutionAdapter(
    config,
    http ?? new QfexHttpClient(config),
    ws ?? new QfexWsClient(config),
  );
}

class QfexExecutionAdapter implements ExecutionAdapter {
  private readonly refdataCache = new Map<
    string,
    { value: QfexRefdataSymbol; expiresAt: number }
  >();
  /** get_order requires the symbol; the ExecutionAdapter port passes only
   * the order id, so submit() records the pair for later lookups. */
  private readonly orderSymbols = new Map<string, string>();
  /** Stop-order ids (from a stop_order_response on TP/SL placement):
   * `cancel_order` cannot address them — they route to
   * `cancel_stop_order {stop_order_id}`. */
  private readonly stopOrderIds = new Set<string>();
  /** Per-order fill recovery (VWAP + fee) memoized once the order is
   * terminal, so the monitor's re-poll loop pays one WS round trip per
   * order — Arcus parity (docs/exchanges/arcus.md). */
  private readonly orderFillsCache = new Map<
    string,
    { averageFillPriceUsd?: string; feeUsd?: string }
  >();

  constructor(
    private readonly config: QfexConfig,
    private readonly http: QfexHttpApi,
    private readonly ws: QfexWsApi,
  ) {}

  async getBestBidOffer(input: PriceRequest): Promise<BestBidOffer> {
    const { qfexSymbol } = qfexSymbolFor(input.symbol);
    const book = expectShape<QfexOrderBook>(
      requiredRecord(
        await this.http.get(`/md/orderbook/${encodeURIComponent(qfexSymbol)}`),
        "QFEX orderbook",
      ),
    );
    return {
      bidUsd: bestLevel(book.bids, "bid", qfexSymbol),
      askUsd: bestLevel(book.asks, "ask", qfexSymbol),
      receivedAt: new Date(),
    };
  }

  async getMarketMetadata(input: PriceRequest): Promise<MarketMetadata> {
    const refdata = await this.getRefdata(input.symbol);
    return {
      minQuantityBase: decimalField(refdata.min_quantity, "refdata.min_quantity"),
      quantityStepBase: decimalField(refdata.lot_size, "refdata.lot_size"),
      priceTickUsd: decimalField(refdata.tick_size, "refdata.tick_size"),
      maxLeverage:
        typeof refdata.default_max_leverage === "number" &&
        Number.isInteger(refdata.default_max_leverage) &&
        refdata.default_max_leverage > 0
          ? refdata.default_max_leverage
          : undefined,
      positionMode: "one-way",
    };
  }

  async getAvailableMarginUsd(): Promise<string> {
    this.requireCredentials();
    const payload = expectShape<QfexPositionsResponse>(
      requiredRecord(
        await this.http.get("/user/positions", { private: true }),
        "QFEX positions response",
      ),
    );
    const balance = payload.balance;
    if (!balance || typeof balance.available_balance !== "number") {
      throw new Error(
        "QFEX positions response did not include balance.available_balance",
      );
    }
    return decimalFromNumber(balance.available_balance, "balance.available_balance");
  }

  async validateExecutionPreflight(input: {
    symbol: string;
    leverage: number;
  }): Promise<void> {
    this.requireTradingEnabled();
    this.requireCredentials();
    const metadata = await this.getMarketMetadata({
      symbol: input.symbol,
      marketType: "perpetual",
      priceSource: "last",
    });
    if (
      metadata.maxLeverage !== undefined &&
      input.leverage > metadata.maxLeverage
    ) {
      throw new Error(
        `QFEX leverage ${input.leverage} exceeds market max ${metadata.maxLeverage}`,
      );
    }
    const availableMargin = await this.getAvailableMarginUsd();
    if (Number(availableMargin) <= 0) {
      throw new Error("QFEX available margin is zero");
    }
    if (!this.http.post) {
      throw new Error("QFEX HTTP client does not support POST");
    }
    // Align the exchange leverage with the bot-configured value. REST
    // endpoint (no WS needed); an exchange rejection surfaces as a
    // preflight failure. See docs/exchanges/qfex.md.
    const { qfexSymbol } = qfexSymbolFor(input.symbol);
    await this.http.post(
      "/user/leverage",
      { symbol: qfexSymbol, leverage: input.leverage },
      { private: true },
    );
  }

  async submitExecutionOrder(
    input: ExecutionOrderRequest,
  ): Promise<ExecutionOrder> {
    this.requireTradingEnabled();
    this.requireCredentials();
    const refdata = await this.getRefdata(input.symbol);
    const { qfexSymbol } = qfexSymbolFor(input.symbol);
    const side = input.side === "buy" ? "BUY" : "SELL";
    const quantity = roundDecimalToStep(
      input.quantityBase,
      decimalField(refdata.lot_size, "refdata.lot_size"),
      "down",
    );
    if (compareDecimals(quantity, "0") <= 0) {
      throw new Error(
        `QFEX quantity ${input.quantityBase} rounds to zero at lot size ${refdata.lot_size}`,
      );
    }
    if (
      compareDecimals(
        quantity,
        decimalField(refdata.min_quantity, "refdata.min_quantity"),
      ) < 0
    ) {
      throw new Error(
        `QFEX quantity ${quantity} is below refdata min_quantity ${refdata.min_quantity}`,
      );
    }

    const params = this.buildAddOrderParams(
      input,
      refdata,
      qfexSymbol,
      side,
      quantity,
    );
    const response = requiredRecord(
      await this.ws.command("add_order", params, {
        correlationKey: { clientOrderId: input.clientOrderId },
      }),
      "QFEX add_order response",
    );
    return this.mapSubmittedOrder(response, qfexSymbol);
  }

  async getExecutionOrder(orderId: string): Promise<ExecutionOrder> {
    this.requireCredentials();
    const symbol = this.orderSymbols.get(orderId);
    if (!symbol) {
      throw new Error(
        `QFEX get_order requires the symbol and no submit recorded one for order ${orderId}`,
      );
    }
    const response = requiredRecord(
      await this.ws.command(
        "get_order",
        { order_id: orderId, symbol },
        { correlationKey: { orderId } },
      ),
      "QFEX get_order response",
    );
    const mapped = mapExecutionOrder(orderId, response);
    // Per-order fills (VWAP + real fee) are recovered once the order is
    // terminal — the order_response carries no fee and its price is the
    // ORDER price, not the average fill (docs/exchanges/qfex.md).
    if (mapped.status === "filled" || mapped.status === "partially_filled") {
      const fills = await this.getOrderFills(orderId, symbol, {
        terminal: mapped.status === "filled",
      });
      if (fills.averageFillPriceUsd !== undefined) {
        mapped.averageFillPriceUsd = fills.averageFillPriceUsd;
      }
      if (fills.feeUsd !== undefined) mapped.feeUsd = fills.feeUsd;
    }
    return mapped;
  }

  async cancelExecutionOrder(orderId: string): Promise<void> {
    this.requireTradingEnabled();
    this.requireCredentials();
    if (this.stopOrderIds.has(orderId)) {
      // Stop orders are addressed by a dedicated command (per the
      // AsyncAPI, cancel_order cannot reach them). The command needs no
      // symbol; it resolves on stop_order_response (matched by
      // stop_order_id), ack, or err.
      await this.ws.command(
        "cancel_stop_order",
        { stop_order_id: orderId },
        { correlationKey: { orderId } },
      );
      return;
    }
    const symbol = this.orderSymbols.get(orderId);
    if (!symbol) {
      throw new Error(
        `QFEX cancel_order requires the symbol and no submit recorded one for order ${orderId}`,
      );
    }
    await this.ws.command(
      "cancel_order",
      { symbol, order_id: orderId, cancel_order_id_type: "order_id" },
      { correlationKey: { orderId } },
    );
  }

  async getPosition(input: {
    symbol: string;
    side: "long" | "short";
  }): Promise<ExchangePosition | null> {
    this.requireCredentials();
    const { qfexSymbol } = qfexSymbolFor(input.symbol);
    const payload = expectShape<QfexPositionsResponse>(
      requiredRecord(
        await this.http.get("/user/positions", { private: true }),
        "QFEX positions response",
      ),
    );
    const positions = Array.isArray(payload.positions) ? payload.positions : [];
    const position = positions.find(
      (row): row is QfexPosition =>
        Boolean(row) &&
        typeof row === "object" &&
        row.symbol?.toUpperCase() === qfexSymbol,
    );
    if (!position || typeof position.position !== "number") return null;
    // `position` is signed: positive = long, negative = short.
    const isLong = position.position > 0;
    if ((input.side === "long") !== isLong) return null;
    if (Math.abs(position.position) < 1e-12) return null;
    return {
      side: input.side,
      quantityBase: decimalFromNumber(
        Math.abs(position.position),
        "position.position",
      ),
      entryPriceUsd:
        typeof position.average_price === "number" && position.average_price > 0
          ? decimalFromNumber(position.average_price, "position.average_price")
          : undefined,
      status: "open",
    };
  }

  /** Exchange-direct account fill history for /volume: private
   * GET /user/trade paginated by limit (<=1000)/offset, bounded page loop.
   * notional = price × quantity as exact decimal strings (the payload uses
   * JSON numbers; the product never goes through floating point); `fee`
   * is a real per-trade value, never estimated. Rows without a usable
   * notional/side/timestamp are skipped with a warning. */
  async getAccountFills(input: { symbol: string }): Promise<AccountFill[]> {
    this.requireCredentials();
    const { qfexSymbol } = qfexSymbolFor(input.symbol);
    const fills: AccountFill[] = [];
    let offset = 0;
    for (let page = 0; page < USER_TRADES_MAX_PAGES; page += 1) {
      const payload = expectShape<QfexTradesResponse>(
        requiredRecord(
          await this.http.get("/user/trade", {
            private: true,
            query: { symbol: qfexSymbol, limit: USER_TRADES_PAGE_LIMIT, offset },
          }),
          "QFEX user trades response",
        ),
      );
      const records = Array.isArray(payload.data) ? payload.data : [];
      for (const trade of records) {
        const parsed = parseAccountTrade(trade);
        if (parsed === undefined) {
          console.warn("QFEX user trade missing price/quantity/side/timestamp; skipping for volume", {
            symbol: qfexSymbol,
            tradeId: trade?.id,
          });
          continue;
        }
        fills.push(parsed);
      }
      if (records.length < USER_TRADES_PAGE_LIMIT) break;
      offset += records.length;
    }
    return fills;
  }

  /** Best-effort recovery of the exit data for a leg the position monitor
   * already detected as flat. Primary path: the stored TP/SL order ids via
   * WS get_order — a fired trigger reports FILLED, and the fill itself is
   * reconstructed from get_user_trades by order_id (exact VWAP + real fee).
   * Fallback (manual close / operator-moved trigger, which cancels the
   * protection orders unfired): closing-side history from REST
   * GET /user/trade, walked newest-first until the leg quantity is covered
   * (exact-decimal VWAP, summed fee), or the single newest trade when no
   * quantity is known. realised_pnl_change's fee convention is UNVERIFIED
   * (docs/exchanges/qfex.md), so it is never returned as realizedPnlUsd —
   * the bot-derived gross from entry/exit/qty stays canonical. Degrades to
   * null on any failure; never throws. */
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
      this.requireCredentials();
    } catch {
      return null;
    }
    try {
      const { qfexSymbol } = qfexSymbolFor(input.symbol);
      for (const [kind, id] of [
        ["tp", input.tpOrderId],
        ["sl", input.slOrderId],
      ] as const) {
        if (!id) continue;
        let order: Record<string, unknown>;
        try {
          order = requiredRecord(
            await this.ws.command(
              "get_order",
              { order_id: id, symbol: qfexSymbol },
              { correlationKey: { orderId: id } },
            ),
            "QFEX TPSL order",
          );
        } catch {
          // Missing or cancelled order: this id has nothing to teach us.
          continue;
        }
        const status =
          typeof order.status === "string" ? order.status.toUpperCase() : "";
        if (status !== "FILLED") continue;
        const fills = await this.getOrderFills(id, qfexSymbol, {
          terminal: true,
        });
        const triggerPrice =
          typeof order.price === "number" && order.price > 0
            ? decimalFromNumber(order.price, "order.price")
            : undefined;
        const result = {
          exitPriceUsd: fills.averageFillPriceUsd ?? triggerPrice,
          exitOrderId: id,
          closeReason: kind,
          ...(fills.feeUsd !== undefined ? { feeUsd: fills.feeUsd } : {}),
        };
        console.log("QFEX leg closure resolved", {
          closeReason: result.closeReason,
          exitOrderId: result.exitOrderId,
          exitPriceUsd: result.exitPriceUsd,
          feeUsd: result.feeUsd,
          source: "ws get_order + get_user_trades",
        });
        return result;
      }
      // Stored ids resolved nothing — the exit exists ONLY in the user
      // trades history (manual close / moved trigger). Same fallback
      // posture as the Extended adapter; any failure degrades to null.
      const recovered = await this.resolveClosureFromFills(input, qfexSymbol);
      if (recovered !== null) {
        console.log("QFEX leg closure resolved from fills", {
          closeReason: recovered.closeReason,
          exitOrderId: recovered.exitOrderId,
          exitPriceUsd: recovered.exitPriceUsd,
          feeUsd: recovered.feeUsd,
          fills: recovered.fills,
        });
      }
      return recovered;
    } catch (error) {
      console.warn("QFEX leg closure resolution failed; degrading to null", {
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** Fills-history fallback for resolveLegClosure: REST GET /user/trade
   * rows are matched by closing side (a long closes with SELL, a short
   * with BUY), sorted newest-first by order_timestamp client-side (the
   * endpoint's ordering is not documented), and walked until the leg
   * quantity is covered — exit price as an exact-decimal VWAP, fee summed
   * over the accepted trades (real values only). Partial coverage under
   * 50% of the leg quantity yields null. Throws on unexpected shapes; the
   * caller's try degrades that to null. */
  private async resolveClosureFromFills(
    input: { side: "long" | "short"; quantityBase?: string },
    qfexSymbol: string,
  ): Promise<{
    exitPriceUsd?: string;
    exitOrderId?: string;
    closeReason?: "manual" | "liquidation";
    feeUsd?: string;
    fills: number;
  } | null> {
    const closingSide = input.side === "long" ? "SELL" : "BUY";
    const payload = expectShape<QfexTradesResponse>(
      requiredRecord(
        await this.http.get("/user/trade", {
          private: true,
          query: { symbol: qfexSymbol, limit: USER_TRADES_PAGE_LIMIT },
        }),
        "QFEX user trades response",
      ),
    );
    const matched = (Array.isArray(payload.data) ? payload.data : [])
      .filter(
        (trade) =>
          trade &&
          typeof trade === "object" &&
          typeof trade.side === "string" &&
          trade.side.toUpperCase() === closingSide,
      )
      .slice()
      .sort((a, b) => (b.order_timestamp ?? 0) - (a.order_timestamp ?? 0));

    let cumulative = "0";
    let notional = "0";
    let feeUsd: string | undefined;
    let sawLiquidation = false;
    let exitOrderId: string | undefined;
    let accepted = 0;
    for (const trade of matched) {
      if (
        input.quantityBase !== undefined &&
        compareDecimals(cumulative, input.quantityBase) >= 0
      )
        break;
      if (
        typeof trade.price !== "number" ||
        !(trade.price > 0) ||
        typeof trade.quantity !== "number" ||
        !(trade.quantity > 0) ||
        typeof trade.order_timestamp !== "number"
      )
        continue;
      const price = decimalFromNumber(trade.price, "trade.price");
      const size = decimalFromNumber(trade.quantity, "trade.quantity");
      if (accepted === 0 && typeof trade.order_id === "string") {
        exitOrderId = trade.order_id;
      }
      accepted += 1;
      cumulative = addDecimalStrings(cumulative, size);
      notional = addDecimalStrings(notional, mulDecimalStrings(size, price));
      if (typeof trade.fee === "number" && Number.isFinite(trade.fee)) {
        feeUsd = addDecimalStrings(
          feeUsd ?? "0",
          decimalFromNumber(trade.fee, "trade.fee"),
        );
      }
      // `liquidation` is an opaque string in the schema (no enum
      // documented): only clearly truthy values mark a liquidation.
      if (isTruthyLiquidationFlag(trade.liquidation)) sawLiquidation = true;
      // No leg quantity known: the single newest matching trade is the
      // whole story.
      if (input.quantityBase === undefined) break;
    }
    if (accepted === 0) return null;
    if (
      input.quantityBase !== undefined &&
      compareDecimals(cumulative, input.quantityBase) < 0 &&
      compareDecimals(mulDecimalStrings(cumulative, "2"), input.quantityBase) < 0
    )
      return null;

    return {
      exitPriceUsd: divideScaledDecimal(notional, cumulative),
      exitOrderId,
      closeReason: sawLiquidation ? "liquidation" : "manual",
      ...(feeUsd !== undefined ? { feeUsd } : {}),
      fills: accepted,
    };
  }

  /** Exact per-order fill recovery (VWAP + summed real fee) from WS
   * get_user_trades filtered by order_id. Memoized per order id ONLY when
   * the order is terminal — a resting ALO partial must not pin a stale
   * VWAP/fee, and a transport failure re-fetches on the next poll. Any
   * failure degrades to an empty record (fees stay undefined — never
   * estimated). */
  private async getOrderFills(
    orderId: string,
    symbol: string,
    options: { terminal: boolean },
  ): Promise<{ averageFillPriceUsd?: string; feeUsd?: string }> {
    const cached = this.orderFillsCache.get(orderId);
    if (cached) return cached;
    const recovered: { averageFillPriceUsd?: string; feeUsd?: string } = {};
    let recoveredOk = false;
    try {
      const payload = await this.ws.command("get_user_trades", {
        order_id: orderId,
        limit: ORDER_TRADES_LIMIT,
      });
      const trades = Array.isArray(payload)
        ? payload.filter(
            (row): row is Record<string, unknown> =>
              Boolean(row) && typeof row === "object",
          )
        : [];
      let cumulative = "0";
      let notional = "0";
      let feeUsd: string | undefined;
      for (const trade of trades) {
        if (trade.order_id !== orderId) continue;
        if (
          typeof trade.price !== "number" ||
          !(trade.price > 0) ||
          typeof trade.quantity !== "number" ||
          !(trade.quantity > 0)
        )
          continue;
        const price = decimalFromNumber(trade.price, "trade.price");
        const size = decimalFromNumber(trade.quantity, "trade.quantity");
        cumulative = addDecimalStrings(cumulative, size);
        notional = addDecimalStrings(notional, mulDecimalStrings(size, price));
        if (typeof trade.fee === "number" && Number.isFinite(trade.fee)) {
          feeUsd = addDecimalStrings(
            feeUsd ?? "0",
            decimalFromNumber(trade.fee, "trade.fee"),
          );
        }
      }
      if (compareDecimals(cumulative, "0") > 0) {
        recovered.averageFillPriceUsd = divideScaledDecimal(notional, cumulative);
      }
      if (feeUsd !== undefined) recovered.feeUsd = feeUsd;
      recoveredOk = true;
    } catch (error) {
      console.warn("QFEX per-order fill recovery failed; fees stay unknown", {
        orderId,
        symbol,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (options.terminal && recoveredOk) {
      this.orderFillsCache.set(orderId, recovered);
    }
    return recovered;
  }

  private buildAddOrderParams(
    input: ExecutionOrderRequest,
    refdata: QfexRefdataSymbol,
    qfexSymbol: string,
    side: "BUY" | "SELL",
    quantity: string,
  ): Record<string, unknown> {
    const tick = decimalField(refdata.tick_size, "refdata.tick_size");
    const base = {
      symbol: qfexSymbol,
      side,
      quantity: Number(quantity),
      client_order_id: input.clientOrderId,
    };
    if (input.type === "limit") {
      if (!input.priceUsd) throw new Error("QFEX limit order requires priceUsd");
      return {
        ...base,
        // ALO = add-liquidity-only (cancelled if it would cross) — the
        // post-only posture the entry flow requires (Extended parity).
        order_type: "ALO",
        order_time_in_force: "GTC",
        // Rounding never lifts the price across the book: buys round down,
        // sells round up.
        price: Number(
          roundDecimalToStep(input.priceUsd, tick, side === "BUY" ? "down" : "up"),
        ),
      };
    }
    if (input.type === "market") {
      return {
        ...base,
        order_type: "MARKET",
        order_time_in_force: "IOC",
      };
    }
    if (input.type === "take-profit-market" || input.type === "stop-market") {
      if (!input.triggerPriceUsd) {
        throw new Error("QFEX TP/SL order requires triggerPriceUsd");
      }
      if (!input.reduceOnly) {
        throw new Error("QFEX TP/SL execution orders must be reduce-only");
      }
      return {
        ...base,
        // TAKE_PROFIT / STOP_LOSS trigger on the MARK price and convert to
        // MARKET when reached; they are inherently reduce-only (rejected if
        // they would increase the position). price = trigger.
        order_type:
          input.type === "take-profit-market" ? "TAKE_PROFIT" : "STOP_LOSS",
        order_time_in_force: "GTC",
        price: Number(
          roundDecimalToStep(
            input.triggerPriceUsd,
            tick,
            side === "BUY" ? "down" : "up",
          ),
        ),
      };
    }
    throw new Error(`Unsupported QFEX order type: ${input.type}`);
  }

  private mapSubmittedOrder(
    response: Record<string, unknown>,
    qfexSymbol: string,
  ): ExecutionOrder {
    // TP/SL placement may answer with a stop_order_response instead of an
    // order_response (live-verify, docs/exchanges/qfex.md): the
    // stop_order_id then plays the order-id role.
    if (
      typeof response.stop_order_id === "string" &&
      response.order_id === undefined
    ) {
      const id = response.stop_order_id;
      this.orderSymbols.set(id, qfexSymbol);
      this.stopOrderIds.add(id);
      return { id, status: "new", filledQuantityBase: "0" };
    }
    const id = stringField(response, "order_id", "QFEX add_order order_id");
    const status =
      typeof response.status === "string" ? response.status.toUpperCase() : "";
    // A synchronous rejection/cancellation at placement fails fast instead
    // of returning a dead order id (the entry flow retries post-only
    // crosses from the error, like RISEx PostOnlyOrderMatched).
    if (status && status !== "ACK" && status !== "FILLED" && status !== "IOC_PARTIALLY_FILLED") {
      throw new QfexWsError(
        `QFEX order was not accepted: status=${status}`,
        status,
      );
    }
    this.orderSymbols.set(id, qfexSymbol);
    return mapExecutionOrder(id, response);
  }

  private async getRefdata(botSymbol: string): Promise<QfexRefdataSymbol> {
    const { qfexSymbol } = qfexSymbolFor(botSymbol);
    const cached = this.refdataCache.get(qfexSymbol);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const payload = await this.http.get("/refdata", {
      query: { ticker: qfexSymbol },
    });
    const value = resolveQfexRefdata(payload, botSymbol);
    this.refdataCache.set(qfexSymbol, {
      value,
      expiresAt: Date.now() + REFDATA_TTL_MS,
    });
    return value;
  }

  private requireTradingEnabled(): void {
    if (!this.config.tradingEnabled)
      throw new Error(
        "QFEX trading is disabled; set QFEX_TRADING_ENABLED=true only after credentials and risk controls are ready",
      );
  }

  private requireCredentials(): void {
    if (!this.config.apiKey || !this.config.secretKey) {
      throw new Error(
        "QFEX_API_KEY and QFEX_SECRET_KEY are required for QFEX execution",
      );
    }
  }
}

// ---- order/trade mapping helpers ----

function mapExecutionOrder(
  fallbackId: string,
  payload: Record<string, unknown>,
): ExecutionOrder {
  const status =
    typeof payload.status === "string" ? payload.status.toUpperCase() : "";
  const quantity =
    typeof payload.quantity === "number" && Number.isFinite(payload.quantity)
      ? payload.quantity
      : 0;
  const remaining =
    typeof payload.quantity_remaining === "number" &&
    Number.isFinite(payload.quantity_remaining)
      ? payload.quantity_remaining
      : undefined;
  // quantity_remaining is the only exact fill-size source on an
  // order_response; when absent (e.g. ACK) the filled size is 0.
  const filled =
    remaining === undefined ? 0 : Math.max(quantity - remaining, 0);
  return {
    id:
      typeof payload.order_id === "string" ? payload.order_id : fallbackId,
    status: mapOrderStatus(status),
    filledQuantityBase: decimalFromNumber(filled, "order filled quantity"),
  };
}

function mapOrderStatus(status: string): ExecutionOrder["status"] {
  switch (status) {
    case "ACK":
    case "MODIFIED":
      return "new";
    case "IOC_PARTIALLY_FILLED":
      return "partially_filled";
    case "FILLED":
      return "filled";
    case "CANCELLED":
    case "CANCELLED_STP":
    case "EXPIRED":
    case "IOC_CANCELLED":
      return "cancelled";
    // Every other documented status is a terminal rejection (REJECTED*,
    // INVALID_*, NOT_FOUND, NO_SUCH_ORDER, FAILED_MARGIN_CHECK,
    // RATE_LIMITED, …) — never silently treated as live.
    default:
      return "rejected";
  }
}

function parseAccountTrade(trade: QfexTrade): AccountFill | undefined {
  if (!trade || typeof trade !== "object") return undefined;
  if (
    typeof trade.price !== "number" ||
    !(trade.price > 0) ||
    typeof trade.quantity !== "number" ||
    !(trade.quantity > 0) ||
    typeof trade.order_timestamp !== "number" ||
    !(trade.order_timestamp > 0)
  )
    return undefined;
  const side =
    typeof trade.side === "string" ? trade.side.toUpperCase() : undefined;
  if (side !== "BUY" && side !== "SELL") return undefined;
  const price = decimalFromNumber(trade.price, "trade.price");
  const quantity = decimalFromNumber(trade.quantity, "trade.quantity");
  return {
    notionalUsd: mulDecimalStrings(price, quantity),
    side: side === "BUY" ? "buy" : "sell",
    occurredAt: new Date(trade.order_timestamp * 1000),
    ...(typeof trade.fee === "number" && Number.isFinite(trade.fee)
      ? { feeUsd: decimalFromNumber(trade.fee, "trade.fee") }
      : {}),
  };
}

function bestLevel(
  levels: QfexOrderBook["bids"],
  side: "bid" | "ask",
  symbol: string,
): string {
  if (!Array.isArray(levels)) {
    throw new Error(`QFEX orderbook ${symbol} ${side} side is missing`);
  }
  for (const level of levels) {
    if (!Array.isArray(level) || level.length < 2) continue;
    const [price] = level;
    if (typeof price === "string" && /^-?\d+(\.\d+)?$/.test(price)) {
      return price;
    }
  }
  throw new Error(`QFEX orderbook ${symbol} ${side} side is empty`);
}

/** `liquidation` is an opaque string in the Trade schema (no enum
 * documented); only clearly truthy values mark a liquidation — anything
 * else stays "manual" (docs/exchanges/qfex.md, live-verify list). */
function isTruthyLiquidationFlag(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toUpperCase();
  return (
    normalized === "TRUE" ||
    normalized === "YES" ||
    normalized === "LIQUIDATION" ||
    normalized === "1"
  );
}

// ---- generic payload helpers ----

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is missing or invalid`);
  }
  // SAFETY: validated as a non-array object just above; an unknown-valued
  // record is the honest type for an unvalidated JSON payload.
  return value as Record<string, unknown>;
}

/** Names the expected payload shape after envelope validation. SAFETY:
 * the invariant TypeScript cannot check is that the exchange honors its
 * published schema — every field consumers read off the result is
 * re-validated at the point of use (typeof guards, decimalField), so a
 * schema drift surfaces as a named field error, not silent corruption. */
function expectShape<T>(value: unknown): T {
  return value as T;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = record[key];
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new Error(`${label} is missing`);
}

function decimalField(value: unknown, label: string): string {
  const raw =
    typeof value === "string" || typeof value === "number"
      ? String(value)
      : undefined;
  if (raw === undefined || !/^-?\d+(\.\d+)?$/.test(raw)) {
    throw new Error(`${label} must be a decimal string`);
  }
  return raw;
}

/** JSON number → plain decimal string without exponent notation (the QFEX
 * REST/WS payloads use numbers; very small magnitudes would otherwise
 * render as "1e-7"). */
function decimalFromNumber(value: number, field: string): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  const raw = String(value);
  if (!/[eE]/.test(raw)) return raw;
  if (Math.abs(value) >= 1e21) {
    throw new Error(`${field} is too large for an exact decimal string`);
  }
  const fixed = value.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
  if (!/^-?\d+(\.\d+)?$/.test(fixed)) {
    throw new Error(`${field} cannot be rendered as a decimal string`);
  }
  return fixed;
}

// ---- exact decimal math (scaled BigInt; same discipline as the Extended
// adapter — no floating point) ----

function decimalParts(value: string): { mantissa: bigint; scale: bigint } {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new Error(`Expected a decimal string, got ${value}`);
  const mantissa = BigInt(
    `${match[1] === "-" ? "-" : ""}${match[2]}${match[3] ?? ""}`,
  );
  return { mantissa, scale: 10n ** BigInt((match[3] ?? "").length) };
}

function formatScaledDecimal(mantissa: bigint, scale: bigint): string {
  if (mantissa === 0n) return "0";
  const negative = mantissa < 0n;
  const abs = negative ? -mantissa : mantissa;
  const integer = abs / scale;
  const remainder = abs % scale;
  if (remainder === 0n) {
    return negative ? `-${integer.toString(10)}` : integer.toString(10);
  }
  const width = scale.toString(10).length - 1;
  const fraction = remainder
    .toString(10)
    .padStart(width, "0")
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${integer.toString(10)}.${fraction}`;
}

function compareDecimals(a: string, b: string): number {
  const pa = decimalParts(a);
  const pb = decimalParts(b);
  const left = pa.mantissa * pb.scale;
  const right = pb.mantissa * pa.scale;
  return left < right ? -1 : left > right ? 1 : 0;
}

function addDecimalStrings(a: string, b: string): string {
  const pa = decimalParts(a);
  const pb = decimalParts(b);
  return formatScaledDecimal(
    pa.mantissa * pb.scale + pb.mantissa * pa.scale,
    pa.scale * pb.scale,
  );
}

function mulDecimalStrings(a: string, b: string): string {
  const pa = decimalParts(a);
  const pb = decimalParts(b);
  return formatScaledDecimal(pa.mantissa * pb.mantissa, pa.scale * pb.scale);
}

/** Exact decimal division with long division — the VWAP over accepted
 * fills. No floating point; a zero denominator throws. */
function divideScaledDecimal(numerator: string, denominator: string): string {
  const n = decimalParts(numerator);
  const d = decimalParts(denominator);
  if (d.mantissa === 0n) throw new Error("division by zero decimal");
  const negative = (n.mantissa < 0n) !== (d.mantissa < 0n);
  let remainder = (n.mantissa < 0n ? -n.mantissa : n.mantissa) * d.scale;
  const divisor = (d.mantissa < 0n ? -d.mantissa : d.mantissa) * n.scale;
  const integer = remainder / divisor;
  remainder %= divisor;
  if (remainder === 0n) {
    return negative ? `-${integer.toString(10)}` : integer.toString(10);
  }
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

/** Round a decimal to a step multiple (scaled BigInt; same discipline as
 * the Extended order-signing roundDecimalToStep). */
function roundDecimalToStep(
  value: string,
  step: string,
  rounding: "up" | "down",
): string {
  const v = decimalParts(value);
  const s = decimalParts(step);
  if (s.mantissa <= 0n) throw new Error("Step must be greater than 0");
  const quotientNumerator = v.mantissa * s.scale;
  const quotientDenominator = v.scale * s.mantissa;
  const quotient = quotientNumerator / quotientDenominator;
  const remainder = quotientNumerator % quotientDenominator;
  const rounded =
    remainder !== 0n && rounding === "up" && quotientNumerator > 0n
      ? quotient + 1n
      : quotient;
  return formatScaledDecimal(rounded * s.mantissa, s.scale);
}
