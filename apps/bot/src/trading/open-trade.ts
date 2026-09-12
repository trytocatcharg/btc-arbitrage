import { randomUUID } from "node:crypto";
import {
  formatDecimal,
  parseDecimal,
  type ExchangeId,
  type MarketType,
} from "@btc-arbitrage/domain";
import type {
  BestBidOffer,
  ExchangeAdapter,
  ExecutionAdapter,
} from "@btc-arbitrage/exchange-core";
import { JsonFileLogger } from "../logging/json-file-logger.js";

export type OpenTradeState =
  | "awaiting_confirmation"
  | "executing_limit"
  | "hedging"
  | "protecting"
  | "open"
  | "unhedged"
  | "cancelled"
  | "failed";
export interface OpenTradePreview {
  token: string;
  signalId: number;
  expiresAt: Date;
  symbol: string;
  marketType: MarketType;
  longExchange: ExchangeId;
  shortExchange: ExchangeId;
  limitExchange: ExchangeId;
  marketExchange: ExchangeId;
  quantityBase: string;
  longPriceUsd: string;
  shortPriceUsd: string;
  makerFeeBps: string;
  takerFeeBps: string;
}
export interface TradeLegUpdate {
  exchangeId: string;
  side: "long" | "short";
  status?:
    | "planned"
    | "submitted"
    | "open"
    | "unhedged"
    | "closed"
    | "cancelled"
    | "failed";
  entryOrderId?: string;
  exitOrderId?: string;
  entryPriceUsd?: string;
  exitPriceUsd?: string;
  closeReason?: string;
  raw?: Record<string, unknown>;
}
export interface TransitionDetails {
  error?: string;
  closeReason?: string;
  legs?: TradeLegUpdate[];
  [key: string]: unknown;
}
export interface PreviewStore {
  createPreview(preview: OpenTradePreview): Promise<void>;
  consumePreview(token: string, now: Date): Promise<OpenTradePreview | null>;
  startExecution(preview: OpenTradePreview, leverage: number): Promise<void>;
  claimRollback(token: string): Promise<boolean>;
  reactivateExecution(preview: OpenTradePreview): Promise<void>;
  transition(
    token: string,
    state: OpenTradeState,
    details?: TransitionDetails,
  ): Promise<void>;
  hasBlockingExecution(): Promise<boolean>;
}
export interface OpenTradeOptions {
  notionalUsd: string;
  leverage: number;
  ttlMs: number;
  quoteMaxAgeMs: number;
  limitTimeoutMs: number;
  /** Cancel-and-replace cadence for the resting maker order. On each check,
   * if the top of the book moved, the order is re-joined at the new best
   * bid (buy) / ask (sell), still post-only. 0 disables repricing.
   * Defaults to DEFAULT_LIMIT_REPRICE_INTERVAL_MS. */
  limitRepriceIntervalMs?: number;
  residualDeltaToleranceBase: string;
  takeProfitPercent: string;
  stopLossPercent: string;
  fees: Record<ExchangeId, { makerBps: string; takerBps: string }>;
  notifyUrgent?: (text: string) => Promise<void>;
  notifyLimitTimeout?: (input: {
    token: string;
    message: string;
  }) => Promise<void>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const openTradeLogger = new JsonFileLogger("logs/open-trade.jsonl");
const PASSIVE_LIMIT_RETRY_COUNT = 3;
const DEFAULT_LIMIT_REPRICE_INTERVAL_MS = 2000;
// Below this remaining size (BTC) a reprice resubmission is skipped: the
// venue minimum quantity would reject the replacement order anyway.
const REPRICE_MIN_REMAINING_BASE = 0.0001;

export class OpenTradeService {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(
    private readonly registry: { get(id: string): ExchangeAdapter },
    private readonly store: PreviewStore,
    private readonly options: OpenTradeOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async createPreview(input: {
    signalId: number;
    symbol: string;
    marketType: MarketType;
    exchanges: [ExchangeId, ExchangeId];
  }): Promise<OpenTradePreview> {
    const [a, b] = input.exchanges.map((id) => this.registry.get(id));
    const [aBbo, bBbo, aMeta, bMeta] = await Promise.all([
      this.execution(a).getBestBidOffer({
        symbol: input.symbol,
        marketType: input.marketType,
        priceSource: "last",
      }),
      this.execution(b).getBestBidOffer({
        symbol: input.symbol,
        marketType: input.marketType,
        priceSource: "last",
      }),
      this.execution(a).getMarketMetadata({
        symbol: input.symbol,
        marketType: input.marketType,
        priceSource: "last",
      }),
      this.execution(b).getMarketMetadata({
        symbol: input.symbol,
        marketType: input.marketType,
        priceSource: "last",
      }),
    ]);
    this.assertFresh(aBbo.receivedAt);
    this.assertFresh(bBbo.receivedAt);
    const aSell = parseDecimal(aBbo.bidUsd),
      bSell = parseDecimal(bBbo.bidUsd);
    const short = aSell >= bSell ? a.id : b.id;
    const long = short === a.id ? b.id : a.id;
    const longQuote = long === a.id ? aBbo.askUsd : bBbo.askUsd;
    const shortQuote = short === a.id ? aBbo.bidUsd : bBbo.bidUsd;
    const { limitExchange, marketExchange } = selectEntryExecutionExchanges({
      longExchange: long,
      shortExchange: short,
      fees: this.options.fees,
    });
    const quantity = this.computeQuantityBase({
      longQuote,
      shortQuote,
      aMeta,
      bMeta,
    });
    const preview: OpenTradePreview = {
      token: randomUUID(),
      signalId: input.signalId,
      expiresAt: new Date(this.now().getTime() + this.options.ttlMs),
      symbol: input.symbol,
      marketType: input.marketType,
      longExchange: long,
      shortExchange: short,
      limitExchange,
      marketExchange,
      quantityBase: formatDecimal(quantity, 10),
      longPriceUsd: longQuote,
      shortPriceUsd: shortQuote,
      makerFeeBps: this.options.fees[limitExchange].makerBps,
      takerFeeBps: this.options.fees[marketExchange].takerBps,
    };
    console.log("OpenTrade preview created", {
      token: preview.token,
      signalId: preview.signalId,
      longExchange: preview.longExchange,
      shortExchange: preview.shortExchange,
      limitExchange: preview.limitExchange,
      marketExchange: preview.marketExchange,
      quantityBase: preview.quantityBase,
      longPriceUsd: preview.longPriceUsd,
      shortPriceUsd: preview.shortPriceUsd,
    });
    await openTradeLogger.write({
      timestamp: new Date().toISOString(),
      event: "open_trade_preview_created",
      token: preview.token,
      signalId: preview.signalId,
      symbol: preview.symbol,
      longExchange: preview.longExchange,
      shortExchange: preview.shortExchange,
      limitExchange: preview.limitExchange,
      marketExchange: preview.marketExchange,
      quantityBase: preview.quantityBase,
      longPriceUsd: preview.longPriceUsd,
      shortPriceUsd: preview.shortPriceUsd,
      expiresAt: preview.expiresAt.toISOString(),
    });
    await this.store.createPreview(preview);
    return preview;
  }

  private computeQuantityBase(input: {
    longQuote: string;
    shortQuote: string;
    aMeta: { minQuantityBase: string; quantityStepBase: string };
    bMeta: { minQuantityBase: string; quantityStepBase: string };
  }): number {
    const commonStep = Math.max(
      parseDecimal(input.aMeta.quantityStepBase),
      parseDecimal(input.bMeta.quantityStepBase),
    );
    const min = Math.max(
      parseDecimal(input.aMeta.minQuantityBase),
      parseDecimal(input.bMeta.minQuantityBase),
    );
    const quantity =
      Math.floor(
        parseDecimal(this.options.notionalUsd) /
          Math.max(
            parseDecimal(input.longQuote),
            parseDecimal(input.shortQuote),
          ) /
          commonStep,
      ) * commonStep;
    if (quantity < min)
      throw new Error(
        "Configured notional is below one or both market minimum quantities",
      );
    return quantity;
  }

  /**
   * Re-attempts the limit entry after a timeout cancellation. Re-validates
   * quote freshness, quantity and market minimums against live BBO, then
   * re-runs the entry phase. The preview must not be expired.
   */
  async retryEntry(preview: OpenTradePreview): Promise<void> {
    if (preview.expiresAt.getTime() <= this.now().getTime())
      throw new Error("Preview expired; open a new trade from a fresh signal");
    const longExecution = this.execution(
      this.registry.get(preview.longExchange),
    );
    const shortExecution = this.execution(
      this.registry.get(preview.shortExchange),
    );
    const [longBbo, shortBbo, longMeta, shortMeta] = await Promise.all([
      longExecution.getBestBidOffer({
        symbol: preview.symbol,
        marketType: preview.marketType,
        priceSource: "last",
      }),
      shortExecution.getBestBidOffer({
        symbol: preview.symbol,
        marketType: preview.marketType,
        priceSource: "last",
      }),
      longExecution.getMarketMetadata({
        symbol: preview.symbol,
        marketType: preview.marketType,
        priceSource: "last",
      }),
      shortExecution.getMarketMetadata({
        symbol: preview.symbol,
        marketType: preview.marketType,
        priceSource: "last",
      }),
    ]);
    this.assertFresh(longBbo.receivedAt);
    this.assertFresh(shortBbo.receivedAt);
    const longQuote = longBbo.askUsd;
    const shortQuote = shortBbo.bidUsd;
    const quantity = this.computeQuantityBase({
      longQuote,
      shortQuote,
      aMeta: longMeta,
      bMeta: shortMeta,
    });
    preview.quantityBase = formatDecimal(quantity, 10);
    preview.longPriceUsd = longQuote;
    preview.shortPriceUsd = shortQuote;
    await this.store.reactivateExecution(preview);
    await this.store.transition(preview.token, "executing_limit");
    console.log("OpenTrade retry revalidated", {
      token: preview.token,
      quantityBase: preview.quantityBase,
      longPriceUsd: preview.longPriceUsd,
      shortPriceUsd: preview.shortPriceUsd,
    });
    await this.runEntry(preview, "-retry");
  }

  async confirm(token: string): Promise<void> {
    console.log("OpenTrade confirm started", { token });
    await openTradeLogger.write({
      timestamp: new Date().toISOString(),
      event: "open_trade_confirm_started",
      token,
    });
    const preview = await this.store.consumePreview(token, this.now());
    if (!preview)
      throw new Error("Preview was already consumed, cancelled or expired");
    await openTradeLogger.write({
      timestamp: new Date().toISOString(),
      event: "open_trade_preview_consumed",
      token,
      signalId: preview.signalId,
      symbol: preview.symbol,
      longExchange: preview.longExchange,
      shortExchange: preview.shortExchange,
      limitExchange: preview.limitExchange,
      marketExchange: preview.marketExchange,
      quantityBase: preview.quantityBase,
    });
    if (await this.store.hasBlockingExecution()) {
      await this.store.transition(token, "cancelled", {
        error: "blocked_by_active_trade",
      });
      throw new Error(
        "Another trade is active or awaiting confirmation; refusing to open a duplicate",
      );
    }
    await this.store.startExecution(preview, this.options.leverage);
    await this.store.transition(token, "executing_limit");
    console.log("OpenTrade execution record created", {
      token,
      signalId: preview.signalId,
      limitExchange: preview.limitExchange,
      marketExchange: preview.marketExchange,
      quantityBase: preview.quantityBase,
    });
    await this.runEntry(preview, "");
  }

  private async runEntry(
    preview: OpenTradePreview,
    orderIdSuffix: string,
  ): Promise<void> {
    const token = preview.token;
    const limit = this.execution(this.registry.get(preview.limitExchange));
    const market = this.execution(this.registry.get(preview.marketExchange));
    let limitOrder: string | undefined;
    let covered = 0;
    const protectionOrderIds: Array<{ adapter: ExecutionAdapter; id: string }> =
      [];
    try {
      const [, , limitMarginUsd, marketMarginUsd] = await Promise.all([
        limit.validateExecutionPreflight({
          symbol: preview.symbol,
          leverage: this.options.leverage,
        }),
        market.validateExecutionPreflight({
          symbol: preview.symbol,
          leverage: this.options.leverage,
        }),
        limit.getAvailableMarginUsd(),
        market.getAvailableMarginUsd(),
      ]);
      console.log("OpenTrade preflight ok", {
        token,
        limitExchange: preview.limitExchange,
        marketExchange: preview.marketExchange,
        limitMarginUsd,
        marketMarginUsd,
      });
      await openTradeLogger.write({
        timestamp: new Date().toISOString(),
        event: "open_trade_preflight_ok",
        token,
        symbol: preview.symbol,
        limitExchange: preview.limitExchange,
        marketExchange: preview.marketExchange,
      });
      const limitSide =
        preview.limitExchange === preview.shortExchange ? "sell" : "buy";
      const totalQuantityBase = parseDecimal(preview.quantityBase);
      // activeLimit is rebound whenever repricing swaps the resting order.
      const { order: initialLimit, priceUsd: initialLimitPriceUsd } =
        await this.submitPassiveLimitWithRetry({
          adapter: limit,
          token,
          symbol: preview.symbol,
          exchangeId: preview.limitExchange,
          side: limitSide,
          quantityBase: preview.quantityBase,
          orderIdSuffix,
        });
      let activeLimit = initialLimit;
      let activeLimitPriceUsd = initialLimitPriceUsd;
      limitOrder = activeLimit.id;
      await this.store.transition(token, "executing_limit", {
        legs: [
          {
            exchangeId: preview.limitExchange,
            side: limitSide === "buy" ? "long" : "short",
            status: "submitted",
            entryOrderId: activeLimit.id,
          },
        ],
      });
      let marketFillPrice: string | undefined;
      const started = this.now().getTime();
      let current = activeLimit;
      let lastLoggedStatus = current.status;
      // Fill accounting must survive repricing: fills of cancelled orders
      // move into the settled buckets while the active order's notional is
      // tracked separately, so the increment hedge check and the weighted
      // average entry price stay exact across successive resting orders.
      let settledFilledBase = 0;
      let settledNotionalUsd = 0;
      let activeNotionalUsd = 0;
      let repriceCount = 0;
      let lastRepriceCheckAt = started;
      console.log("OpenTrade fill polling started", {
        token,
        orderId: activeLimit.id,
        limitExchange: preview.limitExchange,
        initialStatus: current.status,
        timeoutMs: this.options.limitTimeoutMs,
      });
      while (true) {
        const filled =
          settledFilledBase + parseDecimal(current.filledQuantityBase);
        if (filled > covered) {
          await this.store.transition(token, "hedging");
          const diff = filled - covered;
          covered = filled;
          if (!current.averageFillPriceUsd)
            throw new Error("Limit order fill is missing averageFillPriceUsd");
          const activeNotional =
            parseDecimal(current.filledQuantityBase) *
            parseDecimal(current.averageFillPriceUsd);
          settledNotionalUsd += activeNotional - activeNotionalUsd;
          activeNotionalUsd = activeNotional;
          const marketSide =
            preview.marketExchange === preview.shortExchange ? "sell" : "buy";
          const hedge = await market.submitExecutionOrder({
            clientOrderId: `${token}-hedge-${filled - diff}`,
            symbol: preview.symbol,
            side: marketSide,
            type: "market",
            quantityBase: formatDecimal(diff, 10),
          });
          console.log("OpenTrade hedge submitted", {
            token,
            marketExchange: preview.marketExchange,
            side: marketSide,
            quantityBase: formatDecimal(diff, 10),
            orderId: hedge.id,
            status: hedge.status,
            averageFillPriceUsd: hedge.averageFillPriceUsd,
          });
          await openTradeLogger.write({
            timestamp: new Date().toISOString(),
            event: "open_trade_hedge_submitted",
            token,
            exchange: preview.marketExchange,
            side: marketSide,
            quantityBase: formatDecimal(diff, 10),
            orderId: hedge.id,
            status: hedge.status,
            averageFillPriceUsd: hedge.averageFillPriceUsd,
            coveredQuantityBase: formatDecimal(covered, 10),
          });
          if (hedge.status !== "filled" || !hedge.averageFillPriceUsd)
            throw new Error("Market hedge was not immediately filled");
          marketFillPrice = hedge.averageFillPriceUsd;
          await this.store.transition(token, "hedging", {
            legs: [
              {
                exchangeId: preview.marketExchange,
                side: marketSide === "buy" ? "long" : "short",
                status: "open",
                entryOrderId: hedge.id,
                entryPriceUsd: hedge.averageFillPriceUsd,
              },
            ],
          });
        }
        if (current.status !== lastLoggedStatus) {
          console.log("OpenTrade limit order update", {
            token,
            orderId: activeLimit.id,
            status: current.status,
            filledQuantityBase: current.filledQuantityBase,
            averageFillPriceUsd: current.averageFillPriceUsd,
            coveredQuantityBase: formatDecimal(covered, 10),
            elapsedMs: this.now().getTime() - started,
          });
          lastLoggedStatus = current.status;
        }
        if (
          current.status === "filled" ||
          this.now().getTime() - started >= this.options.limitTimeoutMs
        )
          break;
        await this.sleep(250);
        current = await limit.getExecutionOrder(activeLimit.id);
        const repriceIntervalMs =
          this.options.limitRepriceIntervalMs ??
          DEFAULT_LIMIT_REPRICE_INTERVAL_MS;
        if (
          repriceIntervalMs > 0 &&
          current.status !== "filled" &&
          this.now().getTime() - lastRepriceCheckAt >= repriceIntervalMs
        ) {
          lastRepriceCheckAt = this.now().getTime();
          let bbo: BestBidOffer;
          try {
            bbo = await limit.getBestBidOffer({
              symbol: preview.symbol,
              marketType: "perpetual",
              priceSource: "last",
            });
          } catch (error) {
            console.warn(
              "OpenTrade reprice quote fetch failed; keeping resting order",
              {
                token,
                orderId: activeLimit.id,
                message: error instanceof Error ? error.message : String(error),
              },
            );
            continue;
          }
          const desiredPriceUsd = limitSide === "buy" ? bbo.bidUsd : bbo.askUsd;
          const remainingBase =
            totalQuantityBase -
            settledFilledBase -
            parseDecimal(current.filledQuantityBase);
          if (
            parseDecimal(desiredPriceUsd) ===
              parseDecimal(activeLimitPriceUsd) ||
            remainingBase <= REPRICE_MIN_REMAINING_BASE
          )
            continue;
          console.log("OpenTrade repricing resting limit order", {
            token,
            orderId: activeLimit.id,
            fromPriceUsd: activeLimitPriceUsd,
            toPriceUsd: desiredPriceUsd,
            remainingBase: formatDecimal(remainingBase, 10),
            repriceCount: repriceCount + 1,
          });
          try {
            await limit.cancelExecutionOrder(activeLimit.id);
          } catch (error) {
            // Likely raced a fill: the venue rejects cancelling a filled
            // order. Re-read it and let the loop top settle any new fill.
            console.warn("OpenTrade reprice cancel failed; re-reading", {
              token,
              orderId: activeLimit.id,
              message: error instanceof Error ? error.message : String(error),
            });
            current = await limit.getExecutionOrder(activeLimit.id);
            continue;
          }
          const settled = await limit.getExecutionOrder(activeLimit.id);
          settledFilledBase += parseDecimal(settled.filledQuantityBase);
          if (settled.averageFillPriceUsd)
            settledNotionalUsd +=
              parseDecimal(settled.filledQuantityBase) *
              parseDecimal(settled.averageFillPriceUsd);
          activeNotionalUsd = 0;
          const settledRemainingBase = totalQuantityBase - settledFilledBase;
          if (settledRemainingBase <= REPRICE_MIN_REMAINING_BASE) {
            // The cancel raced the final fill; nothing left to re-submit.
            current = settled;
            continue;
          }
          try {
            repriceCount += 1;
            const resubmitted = await this.submitPassiveLimitWithRetry({
              adapter: limit,
              token,
              symbol: preview.symbol,
              exchangeId: preview.limitExchange,
              side: limitSide,
              quantityBase: formatDecimal(settledRemainingBase, 10),
              orderIdSuffix: `${orderIdSuffix}-r${repriceCount}`,
            });
            activeLimit = resubmitted.order;
            activeLimitPriceUsd = resubmitted.priceUsd;
            limitOrder = activeLimit.id;
            current = activeLimit;
            console.log("OpenTrade limit repriced", {
              token,
              orderId: activeLimit.id,
              priceUsd: activeLimitPriceUsd,
              quantityBase: formatDecimal(settledRemainingBase, 10),
              repriceCount,
            });
            await openTradeLogger.write({
              timestamp: new Date().toISOString(),
              event: "open_trade_limit_repriced",
              token,
              orderId: activeLimit.id,
              priceUsd: activeLimitPriceUsd,
              quantityBase: formatDecimal(settledRemainingBase, 10),
              repriceCount,
            });
          } catch (error) {
            // The previous order is already cancelled: settle as a soft
            // timeout so covered quantity is still protected downstream.
            const message =
              error instanceof Error ? error.message : String(error);
            console.warn(
              "OpenTrade reprice resubmit failed; settling as timeout",
              { token, message, repriceCount },
            );
            await openTradeLogger.write({
              timestamp: new Date().toISOString(),
              event: "open_trade_limit_reprice_failed",
              token,
              message,
              repriceCount,
            });
            current = settled;
          }
        }
      }
      if (current.status !== "filled") {
        try {
          await limit.cancelExecutionOrder(activeLimit.id);
        } catch (error) {
          // A filled order rejects the cancel; nothing else to do here.
          console.warn("OpenTrade cancel after wait failed", {
            token,
            orderId: activeLimit.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        console.warn("OpenTrade limit timed out and was cancelled", {
          token,
          orderId: activeLimit.id,
          finalStatus: current.status,
          filledQuantityBase: current.filledQuantityBase,
          elapsedMs: this.now().getTime() - started,
        });
        await openTradeLogger.write({
          timestamp: new Date().toISOString(),
          event: "open_trade_limit_cancelled",
          token,
          orderId: activeLimit.id,
          finalStatus: current.status,
          filledQuantityBase: current.filledQuantityBase,
        });
      }
      if (covered <= 0) {
        await this.store.transition(token, "cancelled", {
          closeReason: "limit_timeout",
          legs: [
            {
              exchangeId: preview.limitExchange,
              side: limitSide === "buy" ? "long" : "short",
              status: "cancelled",
              closeReason: "limit_timeout",
              exitOrderId: activeLimit.id,
            },
            {
              exchangeId: preview.marketExchange,
              side: limitSide === "buy" ? "short" : "long",
              status: "cancelled",
              closeReason: "limit_timeout",
            },
          ],
        });
        console.warn("OpenTrade cancelled without fill", {
          token,
          orderId: activeLimit.id,
          finalStatus: current.status,
        });
        await openTradeLogger.write({
          timestamp: new Date().toISOString(),
          event: "open_trade_cancelled_without_fill",
          token,
          orderId: activeLimit.id,
          finalStatus: current.status,
        });
        const limitSideForNotice =
          preview.limitExchange === preview.shortExchange ? "sell" : "buy";
        await this.options.notifyLimitTimeout?.({
          token,
          message:
            `⏱ Limit order en ${preview.limitExchange} (${limitSideForNotice} ` +
            `${preview.quantityBase} ${preview.symbol}) no se llenó en ` +
            `${this.options.limitTimeoutMs}ms y fue cancelada. ¿Reintentar?`,
        });
        await openTradeLogger.write({
          timestamp: new Date().toISOString(),
          event: "open_trade_limit_timeout_notified",
          token,
          orderId: activeLimit.id,
          finalStatus: current.status,
        });
        return;
      }
      const limitFillPrice =
        covered > 0
          ? formatDecimal(settledNotionalUsd / covered, 8)
          : undefined;
      if (!limitFillPrice || !marketFillPrice)
        throw new Error("Cannot protect trade without confirmed fill prices");
      await this.store.transition(token, "protecting", {
        legs: [
          {
            exchangeId: preview.limitExchange,
            side: limitSide === "buy" ? "long" : "short",
            status: "open",
            entryOrderId: activeLimit.id,
            entryPriceUsd: limitFillPrice,
          },
        ],
      });
      const longEntry =
        preview.limitExchange === preview.longExchange
          ? limitFillPrice
          : marketFillPrice;
      const longTp = applyPercentChange(
        longEntry,
        this.options.takeProfitPercent,
        "up",
      );
      const longSl = applyPercentChange(
        longEntry,
        this.options.stopLossPercent,
        "down",
      );
      const longProtection = await this.protect(
        this.execution(this.registry.get(preview.longExchange)),
        preview.longExchange,
        token,
        preview.symbol,
        "sell",
        covered,
        longTp,
        longSl,
        protectionOrderIds,
      );
      const shortProtection = await this.protect(
        this.execution(this.registry.get(preview.shortExchange)),
        preview.shortExchange,
        token,
        preview.symbol,
        "buy",
        covered,
        longSl,
        longTp,
        protectionOrderIds,
      );
      await openTradeLogger.write({
        timestamp: new Date().toISOString(),
        event: "open_trade_protection_submitted",
        token,
        coveredQuantityBase: formatDecimal(covered, 10),
        longTp,
        longSl,
        protectionOrderIds: protectionOrderIds.map((item) => item.id),
      });
      console.log("OpenTrade protection submitted", {
        token,
        coveredQuantityBase: formatDecimal(covered, 10),
        longTp,
        longSl,
        protectionOrderIds: protectionOrderIds.map((item) => item.id),
      });
      await this.store.transition(token, "open", {
        quantityBase: formatDecimal(covered, 10),
        longTp,
        longSl,
        legs: [
          {
            exchangeId: preview.longExchange,
            side: "long",
            raw: {
              tpOrderId: longProtection.tpOrderId,
              slOrderId: longProtection.slOrderId,
              tpTriggerUsd: longTp,
              slTriggerUsd: longSl,
            },
          },
          {
            exchangeId: preview.shortExchange,
            side: "short",
            raw: {
              tpOrderId: shortProtection.tpOrderId,
              slOrderId: shortProtection.slOrderId,
              tpTriggerUsd: longSl,
              slTriggerUsd: longTp,
            },
          },
        ],
      });
      console.log("OpenTrade confirm completed", {
        token,
        coveredQuantityBase: formatDecimal(covered, 10),
        longTp,
        longSl,
      });
      await openTradeLogger.write({
        timestamp: new Date().toISOString(),
        event: "open_trade_confirm_completed",
        token,
        coveredQuantityBase: formatDecimal(covered, 10),
        longTp,
        longSl,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("OpenTrade confirm failed", {
        token,
        coveredQuantityBase: formatDecimal(covered, 10),
        limitOrder,
        message,
      });
      await openTradeLogger.write({
        timestamp: new Date().toISOString(),
        event: "open_trade_confirm_failed",
        token,
        coveredQuantityBase: formatDecimal(covered, 10),
        limitOrder,
        protectionOrderIds: protectionOrderIds.map((item) => item.id),
        error: message,
      });
      const outcomes: string[] = [];
      // Cancel any still-working orders regardless of hedge progress; a
      // filled order simply rejects the cancel and is reported as failed.
      if (limitOrder) {
        try {
          await limit.cancelExecutionOrder(limitOrder);
          outcomes.push("limit cancelled");
        } catch {
          outcomes.push("limit cancel failed");
        }
      }
      for (const item of protectionOrderIds) {
        try {
          await item.adapter.cancelExecutionOrder(item.id);
          outcomes.push(`protection ${item.id} cancelled`);
        } catch {
          outcomes.push(`protection ${item.id} cancel failed`);
        }
      }
      const emergencyCloseIds: Partial<Record<ExchangeId, string>> = {};
      let rollbackClaimed = false;
      if (covered > 0) {
        rollbackClaimed = await this.store.claimRollback(token);
        if (rollbackClaimed) {
          for (const [exchange, side] of [
            [preview.longExchange, "sell"],
            [preview.shortExchange, "buy"],
          ] as const) {
            try {
              const close = await this.execution(
                this.registry.get(exchange),
              ).submitExecutionOrder({
                clientOrderId: `${token}-emergency-${exchange}`,
                symbol: preview.symbol,
                side,
                type: "market",
                quantityBase: formatDecimal(covered, 10),
                reduceOnly: true,
              });
              emergencyCloseIds[exchange] = close.id;
              outcomes.push(
                `${exchange} emergency close submitted (${close.id})`,
              );
            } catch {
              outcomes.push(`${exchange} emergency close failed`);
            }
          }
        } else {
          outcomes.push("rollback already claimed elsewhere");
        }
      }
      // Never declare failure blindly: confirm both exchanges are flat.
      // A residual keeps the trade 'unhedged' so the trade monitor keeps
      // watching the leftover position and notifies when it closes.
      const residual: Array<{
        exchange: string;
        side: string;
        quantityBase: string;
      }> = [];
      if (covered > 0) {
        for (const [exchange, side] of [
          [preview.longExchange, "long"],
          [preview.shortExchange, "short"],
        ] as const) {
          try {
            const quantityBase = await this.waitForFlatPosition(
              exchange,
              side,
              preview.symbol,
            );
            if (quantityBase !== null)
              residual.push({ exchange, side, quantityBase });
          } catch {
            residual.push({ exchange, side, quantityBase: "unknown" });
            outcomes.push(`${exchange} flat verification failed`);
          }
        }
      }
      await openTradeLogger.write({
        timestamp: new Date().toISOString(),
        event: "open_trade_rollback_attempted",
        token,
        outcomes,
        residual,
      });
      const finalState: OpenTradeState =
        residual.length > 0 ? "unhedged" : "failed";
      await this.store.transition(token, finalState, {
        error: message,
        closeReason: "rollback",
        legs: [
          {
            exchangeId: preview.longExchange,
            side: "long",
            status: residual.some((item) => item.side === "long")
              ? "unhedged"
              : covered > 0
                ? "closed"
                : "cancelled",
            closeReason: "rollback",
            exitOrderId: emergencyCloseIds[preview.longExchange],
          },
          {
            exchangeId: preview.shortExchange,
            side: "short",
            status: residual.some((item) => item.side === "short")
              ? "unhedged"
              : covered > 0
                ? "closed"
                : "cancelled",
            closeReason: "rollback",
            exitOrderId: emergencyCloseIds[preview.shortExchange],
          },
        ],
      });
      if (rollbackClaimed || residual.length > 0) {
        await this.options.notifyUrgent?.(
          `🚨 Trade rollback ${token} (${finalState}): ${outcomes.join("; ")}` +
            (residual.length > 0
              ? ` — RESIDUAL: ${residual
                  .map(
                    (item) =>
                      `${item.side} ${item.quantityBase} on ${item.exchange}`,
                  )
                  .join(", ")}`
              : " — flat confirmed"),
        );
      }
      throw error;
    }
  }
  private async submitPassiveLimitWithRetry(input: {
    adapter: ExecutionAdapter;
    token: string;
    symbol: string;
    exchangeId: ExchangeId;
    side: "buy" | "sell";
    quantityBase: string;
    orderIdSuffix: string;
  }): Promise<{
    order: Awaited<ReturnType<ExecutionAdapter["submitExecutionOrder"]>>;
    priceUsd: string;
  }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= PASSIVE_LIMIT_RETRY_COUNT; attempt += 1) {
      const bbo = await input.adapter.getBestBidOffer({
        symbol: input.symbol,
        marketType: "perpetual",
        priceSource: "last",
      });
      const priceUsd = this.passiveLimitPriceFromBbo(bbo, input.side);
      try {
        const order = await input.adapter.submitExecutionOrder({
          clientOrderId: `${input.token}-limit${input.orderIdSuffix}`,
          symbol: input.symbol,
          side: input.side,
          type: "limit",
          quantityBase: input.quantityBase,
          priceUsd,
        });
        console.log("OpenTrade limit submitted", {
          token: input.token,
          limitExchange: input.exchangeId,
          side: input.side,
          quantityBase: input.quantityBase,
          priceUsd,
          orderId: order.id,
          attempt,
        });
        await openTradeLogger.write({
          timestamp: new Date().toISOString(),
          event: "open_trade_limit_submitted",
          token: input.token,
          exchange: input.exchangeId,
          side: input.side,
          quantityBase: input.quantityBase,
          priceUsd,
          orderId: order.id,
          attempt,
        });
        return { order, priceUsd };
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        console.warn("OpenTrade limit submit failed", {
          token: input.token,
          exchange: input.exchangeId,
          side: input.side,
          priceUsd,
          attempt,
          message,
        });
        await openTradeLogger.write({
          timestamp: new Date().toISOString(),
          event: "open_trade_limit_submit_failed",
          token: input.token,
          exchange: input.exchangeId,
          side: input.side,
          quantityBase: input.quantityBase,
          priceUsd,
          attempt,
          error: message,
        });
        if (
          !message.includes("PostOnlyOrderMatched()") ||
          attempt === PASSIVE_LIMIT_RETRY_COUNT
        )
          throw error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Passive limit submission failed");
  }
  private passiveLimitPriceFromBbo(
    bbo: BestBidOffer,
    side: "buy" | "sell",
  ): string {
    return side === "buy" ? bbo.bidUsd : bbo.askUsd;
  }
  private async protect(
    adapter: ExecutionAdapter,
    exchangeId: string,
    token: string,
    symbol: string,
    closeSide: "buy" | "sell",
    qty: number,
    tp: string,
    sl: string,
    known: Array<{ adapter: ExecutionAdapter; id: string }>,
  ): Promise<{ tpOrderId: string; slOrderId: string }> {
    const a = await adapter.submitExecutionOrder({
      clientOrderId: `${token}-tp`,
      symbol,
      side: closeSide,
      type: "take-profit-market",
      quantityBase: formatDecimal(qty, 10),
      triggerPriceUsd: tp,
      reduceOnly: true,
    });
    known.push({ adapter, id: a.id });
    console.log("OpenTrade TP order submitted", {
      token,
      exchange: exchangeId,
      side: closeSide,
      triggerPriceUsd: tp,
      quantityBase: formatDecimal(qty, 10),
      orderId: a.id,
      status: a.status,
    });
    const b = await adapter.submitExecutionOrder({
      clientOrderId: `${token}-sl`,
      symbol,
      side: closeSide,
      type: "stop-market",
      quantityBase: formatDecimal(qty, 10),
      triggerPriceUsd: sl,
      reduceOnly: true,
    });
    known.push({ adapter, id: b.id });
    console.log("OpenTrade SL order submitted", {
      token,
      exchange: exchangeId,
      side: closeSide,
      triggerPriceUsd: sl,
      quantityBase: formatDecimal(qty, 10),
      orderId: b.id,
      status: b.status,
    });
    return { tpOrderId: a.id, slOrderId: b.id };
  }
  private async waitForFlatPosition(
    exchange: string,
    side: "long" | "short",
    symbol: string,
    timeoutMs = 8000,
  ): Promise<string | null> {
    const adapter = this.execution(this.registry.get(exchange));
    const deadline = this.now().getTime() + timeoutMs;
    for (;;) {
      const position = await adapter.getPosition({ symbol, side });
      if (position === null || position.status === "closed") return null;
      if (parseDecimal(position.quantityBase) <= 0) return null;
      if (this.now().getTime() >= deadline) return position.quantityBase;
      await this.sleep(1000);
    }
  }
  private execution(adapter: ExchangeAdapter): ExecutionAdapter {
    if (!adapter.execution)
      throw new Error(`${adapter.id} does not expose execution primitives`);
    return adapter.execution;
  }
  private assertFresh(at: Date) {
    if (this.now().getTime() - at.getTime() > this.options.quoteMaxAgeMs)
      throw new Error("Executable BBO quote is stale");
  }
}

function applyPercentChange(
  value: string,
  percent: string,
  direction: "up" | "down",
): string {
  const multiplier =
    direction === "up"
      ? 1 + parseDecimal(percent, "percent") / 100
      : 1 - parseDecimal(percent, "percent") / 100;
  if (multiplier <= 0)
    throw new Error("Stop loss percent must keep trigger price above zero");
  return formatDecimal(parseDecimal(value) * multiplier);
}

function selectEntryExecutionExchanges(input: {
  longExchange: ExchangeId;
  shortExchange: ExchangeId;
  fees: OpenTradeOptions["fees"];
}): { limitExchange: ExchangeId; marketExchange: ExchangeId } {
  const candidates: Array<{
    limitExchange: ExchangeId;
    marketExchange: ExchangeId;
    makerBps: number;
    takerBps: number;
  }> = [
    {
      limitExchange: input.longExchange,
      marketExchange: input.shortExchange,
      makerBps: parseDecimal(input.fees[input.longExchange].makerBps),
      takerBps: parseDecimal(input.fees[input.shortExchange].takerBps),
    },
    {
      limitExchange: input.shortExchange,
      marketExchange: input.longExchange,
      makerBps: parseDecimal(input.fees[input.shortExchange].makerBps),
      takerBps: parseDecimal(input.fees[input.longExchange].takerBps),
    },
  ];

  candidates.sort((left, right) => {
    if (left.makerBps !== right.makerBps) return left.makerBps - right.makerBps;
    if (left.takerBps !== right.takerBps) return left.takerBps - right.takerBps;
    return left.limitExchange.localeCompare(right.limitExchange);
  });

  return {
    limitExchange: candidates[0]!.limitExchange,
    marketExchange: candidates[0]!.marketExchange,
  };
}
