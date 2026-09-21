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
import { closeTradeBothLegs } from "./trade-close.js";

export type OpenTradeState =
  | "awaiting_confirmation"
  | "executing_limit"
  | "hedging"
  | "protecting"
  | "open"
  | "closing"
  | "unhedged"
  | "closed"
  | "cancelled"
  | "failed";

/** Result of a confirmed execution. `edge_closed` means both fills completed
 * but the captured spread no longer covered exit cost + minimum profit, so
 * the legs were closed immediately at market instead of holding. `cancelled`
 * means the passive limit entry never filled and the trade was cancelled
 * without opening any position. */
export type ConfirmOutcome =
  | { outcome: "opened" }
  | {
      outcome: "edge_closed";
      realizedPnlUsd: string | null;
      capturedSpreadUsd: number;
      minEdgeUsd: number;
    }
  | { outcome: "cancelled" };
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
  realizedPnlUsd?: string;
  /** Monotonic farmed-volume increment (USD notional) applied with
   * `coalesce(filled_notional_usd, 0) + delta` inside the transition's
   * transaction. */
  filledNotionalUsdDelta?: string;
  closeReason?: string;
  raw?: Record<string, unknown>;
}
export interface TransitionDetails {
  error?: string;
  closeReason?: string;
  /** Trade-level farmed-volume increment (USD notional), applied with
   * `coalesce(filled_notional_usd, 0) + delta` inside the transition's
   * transaction. */
  filledNotionalUsdDelta?: string;
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
  /** Reads the trade's cumulative farmed volume (trades.filled_notional_usd)
   * for close notices. Optional: stores without a DB back it out. */
  readFarmedVolumeUsd?(token: string): Promise<string | null>;
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
  /** Number of price ticks to improve the resting limit price beyond the best
   * bid/ask; keeps the order post-only by falling back to join when improving
   * would cross the spread. 0 = legacy join behavior.
   * Defaults to DEFAULT_ENTRY_IMPROVE_TICKS. */
  entryImproveTicks?: number;
  residualDeltaToleranceBase: string;
  takeProfitPercent: string;
  stopLossPercent: string;
  /** Minimum expected convergence profit (USD) required to KEEP a trade
   * right after both fills complete (OPEN_TRADE_MIN_PROFIT_USD, default
   * "0.05"); wired from config since adjust-tpsl-volume-farming PR1. */
  minProfitUsd?: string;
  /** Runtime assertion bound (USD) on the edge-abort path
   * (OPEN_TRADE_MAX_LOSS_USD, default "0.25"); wired from config since PR1,
   * consumed in PR2. */
  maxLossUsd?: string;
  /** Assumed exit slippage in basis points (OPEN_TRADE_SLIPPAGE_BPS,
   * default "2"); wired from config since PR1, consumed in PR2. */
  slippageBps?: string;
  fees: Record<ExchangeId, { makerBps: string; takerBps: string }>;
  notifyUrgent?: (text: string) => Promise<void>;
  notifyLimitTimeout?: (input: {
    token: string;
    message: string;
  }) => Promise<void>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const PASSIVE_LIMIT_RETRY_COUNT = 3;
const DEFAULT_LIMIT_REPRICE_INTERVAL_MS = 2000;
const DEFAULT_ENTRY_IMPROVE_TICKS = 1;
/** Defaults for the PR2 knobs (config wires real values since PR1). */
const DEFAULT_MIN_PROFIT_USD = "0.05";
const DEFAULT_MAX_LOSS_USD = "0.25";
const DEFAULT_SLIPPAGE_BPS = "2";
/** Maximum allowed deviation (basis points) between a protection trigger and
 * its expected fill-anchored level, and between the two legs' cross-symmetry
 * levels. A breach fails the protection step loudly (no orders placed). */
export const PROTECTION_TOLERANCE_BPS = 100;
// Below this remaining size (BTC) a reprice resubmission is skipped: the
// venue minimum quantity would reject the replacement order anyway.
const REPRICE_MIN_REMAINING_BASE = 0.0001;

/** Loud failure of the protection step: thrown when a trigger cannot be
 * trusted to be anchored to a leg's true fill price (tolerance breach,
 * cross-symmetry breach, or corrupt/blended fill provenance). Rides the
 * existing runEntry catch: working orders are cancelled, the trade rolls
 * back, emergency reduce-only closes run, and the operator is notified. */
export class ProtectionAnchorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtectionAnchorError";
  }
}

/** Verifies the full protection anchor set immediately before protection
 * orders are placed (adjust-tpsl-volume-farming design D1): each trigger must
 * sit within PROTECTION_TOLERANCE_BPS of its leg's `fill × (1 ± percent)`
 * level, and the cross-symmetry property must hold — the short leg's SL ≈
 * the long leg's TP and the short leg's TP ≈ the long leg's SL (both venues
 * track the same BTC). Logs the full anchor set on pass; throws
 * ProtectionAnchorError on breach. */
export function assertProtectionAnchors(input: {
  longEntryUsd: string;
  shortEntryUsd: string;
  longTpUsd: string;
  longSlUsd: string;
  shortTpUsd: string;
  shortSlUsd: string;
  takeProfitPercent: string;
  stopLossPercent: string;
}): void {
  const tpFactor = 1 + parseDecimal(input.takeProfitPercent, "percent") / 100;
  const slFactor = 1 - parseDecimal(input.stopLossPercent, "percent") / 100;
  const checks: Array<{ label: string; actual: string; expected: number }> = [
    {
      label: "longTp",
      actual: input.longTpUsd,
      expected: parseDecimal(input.longEntryUsd) * tpFactor,
    },
    {
      label: "longSl",
      actual: input.longSlUsd,
      expected: parseDecimal(input.longEntryUsd) * slFactor,
    },
    // Short profits when price falls: its TP trigger sits BELOW its fill and
    // its SL trigger sits ABOVE it.
    {
      label: "shortTp",
      actual: input.shortTpUsd,
      expected: parseDecimal(input.shortEntryUsd) * slFactor,
    },
    {
      label: "shortSl",
      actual: input.shortSlUsd,
      expected: parseDecimal(input.shortEntryUsd) * tpFactor,
    },
  ];
  const breaches: string[] = [];
  for (const check of checks) {
    const actual = parseDecimal(check.actual);
    if (!(check.expected > 0) || !(actual > 0)) {
      breaches.push(`${check.label}: non-positive actual/expected`);
      continue;
    }
    const deviationBps =
      (Math.abs(actual - check.expected) / check.expected) * 10_000;
    if (deviationBps > PROTECTION_TOLERANCE_BPS)
      breaches.push(
        `${check.label}: ${check.actual} deviates ${deviationBps.toFixed(1)} bps from expected ${check.expected} (> ${PROTECTION_TOLERANCE_BPS} bps)`,
      );
  }
  const longTp = parseDecimal(input.longTpUsd);
  const longSl = parseDecimal(input.longSlUsd);
  const shortTp = parseDecimal(input.shortTpUsd);
  const shortSl = parseDecimal(input.shortSlUsd);
  const crossChecks: Array<{
    label: string;
    left: number;
    right: number;
    rightExpected: number;
  }> = [
    {
      label: "shortSl≈longTp",
      left: shortSl,
      right: longTp,
      rightExpected: longTp,
    },
    {
      label: "shortTp≈longSl",
      left: shortTp,
      right: longSl,
      rightExpected: longSl,
    },
  ];
  for (const check of crossChecks) {
    if (!(check.rightExpected > 0)) {
      breaches.push(`${check.label}: non-positive reference level`);
      continue;
    }
    const deviationBps =
      (Math.abs(check.left - check.right) / check.rightExpected) * 10_000;
    if (deviationBps > PROTECTION_TOLERANCE_BPS)
      breaches.push(
        `${check.label}: ${check.left} vs ${check.right} deviates ${deviationBps.toFixed(1)} bps (> ${PROTECTION_TOLERANCE_BPS} bps)`,
      );
  }
  if (breaches.length > 0)
    throw new ProtectionAnchorError(
      `Protection anchors failed tolerance check: ${breaches.join("; ")}`,
    );
  console.log("Protection anchors verified", {
    longEntryUsd: input.longEntryUsd,
    shortEntryUsd: input.shortEntryUsd,
    longTpUsd: input.longTpUsd,
    longSlUsd: input.longSlUsd,
    shortTpUsd: input.shortTpUsd,
    shortSlUsd: input.shortSlUsd,
    takeProfitPercent: input.takeProfitPercent,
    stopLossPercent: input.stopLossPercent,
    toleranceBps: PROTECTION_TOLERANCE_BPS,
  });
}

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
  async retryEntry(
    preview: OpenTradePreview,
  ): Promise<ConfirmOutcome | undefined> {
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
    return await this.runEntry(preview, "-retry");
  }

  async confirm(token: string): Promise<ConfirmOutcome | undefined> {
    console.log("OpenTrade confirm started", { token });
    const preview = await this.store.consumePreview(token, this.now());
    if (!preview)
      throw new Error("Preview was already consumed, cancelled or expired");
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
    return await this.runEntry(preview, "");
  }

  private async runEntry(
    preview: OpenTradePreview,
    orderIdSuffix: string,
  ): Promise<ConfirmOutcome | undefined> {
    const token = preview.token;
    const limit = this.execution(this.registry.get(preview.limitExchange));
    const market = this.execution(this.registry.get(preview.marketExchange));
    let limitOrder: string | undefined;
    let covered = 0;
    const protectionOrderIds: Array<{ adapter: ExecutionAdapter; id: string }> =
      [];
    try {
      // Execution setup (leverage set on RISEx, order-signing WASM init
      // on Extended) is process-lifetime work hoisted to bot startup —
      // see main.ts. Re-running it per trade added avoidable latency to
      // the entry path; margin/leverage misconfigurations now surface at
      // the submit step instead.
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
      // Provenance of the market (hedge) leg fill price, when the adapter
      // reports it (RISEx). Undefined means the ack is authoritative
      // (order_ack semantics).
      let hedgeFillSource:
        | "order_ack"
        | "order_history"
        | "position_average"
        | undefined;
      let hedgeFillDerived = false;
      let hedgeNotionalUsd = 0;
      const marketSide =
        preview.marketExchange === preview.shortExchange ? "sell" : "buy";
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
      // Why a no-fill entry aborted: plain timeout, or the anti-chase
      // guard stopped repricing once the executable spread inverted.
      let entryAbortReason: "limit_timeout" | "spread_inverted" =
        "limit_timeout";
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
          const hedge = await market.submitExecutionOrder({
            clientOrderId: `${token}-hedge-${filled - diff}`,
            symbol: preview.symbol,
            side: marketSide,
            type: "market",
            quantityBase: formatDecimal(diff, 10),
          });
          hedgeNotionalUsd +=
            diff * parseDecimal(hedge.averageFillPriceUsd ?? "0");
          const hedgeAck = hedge as {
            fillPriceSource?: string;
            fillPriceDerived?: boolean;
          };
          hedgeFillSource =
            (hedgeAck.fillPriceSource as typeof hedgeFillSource) ?? "order_ack";
          hedgeFillDerived = hedgeAck.fillPriceDerived === true;
          console.log("OpenTrade hedge submitted", {
            token,
            marketExchange: preview.marketExchange,
            side: marketSide,
            quantityBase: formatDecimal(diff, 10),
            orderId: hedge.id,
            status: hedge.status,
            averageFillPriceUsd: hedge.averageFillPriceUsd,
          });
          // Venue acks can lag the fill: RISEx returns no status/price in
          // the ack and proves fills via position delta, and its
          // getExecutionOrder throws once the order is filled (it leaves
          // the open-orders list). Never roll back a quantity-complete
          // hedge just because the metadata is stale — a false negative
          // here emergency-closes both legs and crystallizes a loss
          // (observed 2026-09-18). Re-read the order a bounded number of
          // times first; only an unresolved hedge after that is a failure.
          let resolvedHedge = hedge;
          const hedgeFilledBase = parseDecimal(hedge.filledQuantityBase ?? "0");
          if (
            (hedge.status !== "filled" || !hedge.averageFillPriceUsd) &&
            hedgeFilledBase >= diff - 1e-10
          ) {
            for (let attempt = 1; attempt <= 6; attempt += 1) {
              await this.sleep(500);
              try {
                const latest = await market.getExecutionOrder(hedge.id);
                console.log("OpenTrade hedge fill re-poll", {
                  token,
                  orderId: hedge.id,
                  attempt,
                  status: latest.status,
                  averageFillPriceUsd: latest.averageFillPriceUsd,
                });
                if (latest.status === "filled" && latest.averageFillPriceUsd) {
                  resolvedHedge = { ...hedge, ...latest };
                  break;
                }
              } catch (error) {
                console.warn("OpenTrade hedge fill re-poll failed", {
                  token,
                  orderId: hedge.id,
                  attempt,
                  message:
                    error instanceof Error ? error.message : String(error),
                });
              }
            }
          }
          if (
            resolvedHedge.status !== "filled" ||
            !resolvedHedge.averageFillPriceUsd
          )
            throw new Error("Market hedge was not immediately filled");
          marketFillPrice = resolvedHedge.averageFillPriceUsd;
          await this.store.transition(token, "hedging", {
            legs: [
              {
                exchangeId: preview.marketExchange,
                side: marketSide === "buy" ? "long" : "short",
                status: "open",
                entryOrderId: hedge.id,
                entryPriceUsd: resolvedHedge.averageFillPriceUsd,
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
        if (current.status === "filled") break;
        if (this.now().getTime() - started >= this.options.limitTimeoutMs) {
          // Timeout: cancel the resting order and settle any fill that
          // raced the cancel before giving up on the trade. Extended has
          // accepted a cancel on an already-filled order (observed
          // 2026-09-21), which left a naked position on the limit venue
          // while the bot believed nothing filled. Re-read with bounded
          // retries, keep the max-filled state, and continue the loop on
          // a late fill so the increment hedge runs before re-checking.
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
          const settled = await this.readOrderAfterCancel(
            limit,
            activeLimit.id,
            current,
          );
          if (
            parseDecimal(settled.filledQuantityBase) >
            parseDecimal(current.filledQuantityBase)
          ) {
            console.warn("OpenTrade late fill detected after cancel", {
              token,
              orderId: activeLimit.id,
              finalStatus: settled.status,
              filledQuantityBase: settled.filledQuantityBase,
              averageFillPriceUsd: settled.averageFillPriceUsd,
              elapsedMs: this.now().getTime() - started,
            });
            current = settled;
            continue;
          }
          console.warn("OpenTrade limit timed out and was cancelled", {
            token,
            orderId: activeLimit.id,
            finalStatus: settled.status,
            filledQuantityBase: settled.filledQuantityBase,
            elapsedMs: this.now().getTime() - started,
          });
          current = settled;
          break;
        }
        await this.sleep(250);
        // Extended has read-after-write lag: an order created seconds ago
        // can briefly 404 on GET (observed 2026-09-14, and historical
        // 404s on 2026-08-20 / 2026-09-08). A transient poll failure must
        // not kill the trade — keep the last known state and retry.
        try {
          current = await limit.getExecutionOrder(activeLimit.id);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.warn("OpenTrade order status poll failed; retrying", {
            token,
            orderId: activeLimit.id,
            message,
            elapsedMs: this.now().getTime() - started,
          });
          continue;
        }
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
          let meta: Awaited<ReturnType<ExecutionAdapter["getMarketMetadata"]>>;
          let otherBbo: BestBidOffer;
          try {
            [bbo, meta, otherBbo] = await Promise.all([
              limit.getBestBidOffer({
                symbol: preview.symbol,
                marketType: "perpetual",
                priceSource: "last",
              }),
              limit.getMarketMetadata({
                symbol: preview.symbol,
                marketType: "perpetual",
                priceSource: "last",
              }),
              // Anti-chase guard input: the hedge side's executable quote.
              market.getBestBidOffer({
                symbol: preview.symbol,
                marketType: "perpetual",
                priceSource: "last",
              }),
            ]);
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
          // Must use the same improve-by-tick pricing as the submit path,
          // else the resting order would be repriced every interval
          // (constant queue reset).
          const desiredPriceUsd = this.passiveLimitPriceFromBbo(
            bbo,
            limitSide,
            meta.priceTickUsd,
          );
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
          // Anti-chase guard: never reprice past the point where the
          // cross-venue executable spread stops covering round-trip cost
          // + minimum profit. Without it, an aggressive limit chases a
          // moving book into a guaranteed-loss fill (observed 2026-09-21:
          // buy filled at 84800 while the hedge side bid was 84770 — a
          // -$30 entry). The signal can be a mark-price illusion; the
          // executable BBO is the truth.
          const hedgeQuoteUsd =
            limitSide === "buy" ? otherBbo.bidUsd : otherBbo.askUsd;
          const priceEdgeUsd =
            limitSide === "buy"
              ? parseDecimal(hedgeQuoteUsd) - parseDecimal(desiredPriceUsd)
              : parseDecimal(desiredPriceUsd) - parseDecimal(hedgeQuoteUsd);
          const prospectiveEdgeUsd = priceEdgeUsd * remainingBase;
          const limitFees = this.options.fees[preview.limitExchange];
          const marketFees = this.options.fees[preview.marketExchange];
          const limitNotionalUsd =
            parseDecimal(desiredPriceUsd) * remainingBase;
          const hedgeNotionalUsd = parseDecimal(hedgeQuoteUsd) * remainingBase;
          const guardEntryFeesUsd =
            (limitNotionalUsd * parseDecimal(limitFees.makerBps) +
              hedgeNotionalUsd * parseDecimal(marketFees.takerBps)) /
            10_000;
          const guardExitFeesUsd =
            (limitNotionalUsd * parseDecimal(limitFees.takerBps) +
              hedgeNotionalUsd * parseDecimal(marketFees.takerBps)) /
            10_000;
          const guardSlippageUsd =
            ((limitNotionalUsd + hedgeNotionalUsd) *
              parseDecimal(this.options.slippageBps ?? DEFAULT_SLIPPAGE_BPS)) /
            10_000;
          const guardBufferUsd =
            guardEntryFeesUsd +
            guardExitFeesUsd +
            guardSlippageUsd +
            parseDecimal(this.options.minProfitUsd ?? DEFAULT_MIN_PROFIT_USD);
          if (prospectiveEdgeUsd < guardBufferUsd) {
            console.warn(
              "OpenTrade repricing stopped: executable spread below cost",
              {
                token,
                orderId: activeLimit.id,
                desiredPriceUsd,
                hedgeQuoteUsd,
                prospectiveEdgeUsd,
                guardBufferUsd,
                remainingBase: formatDecimal(remainingBase, 10),
              },
            );
            try {
              await limit.cancelExecutionOrder(activeLimit.id);
            } catch (error) {
              console.warn("OpenTrade anti-chase cancel failed; re-reading", {
                token,
                orderId: activeLimit.id,
                message: error instanceof Error ? error.message : String(error),
              });
            }
            const settled = await this.readOrderAfterCancel(
              limit,
              activeLimit.id,
              current,
            );
            if (
              parseDecimal(settled.filledQuantityBase) >
              parseDecimal(current.filledQuantityBase)
            ) {
              // A fill raced the cancel: let the loop top hedge it, then
              // the post-loop edge band decides whether to keep it.
              current = settled;
              continue;
            }
            current = settled;
            entryAbortReason = "spread_inverted";
            break;
          }
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
          } catch (error) {
            // The previous order is already cancelled: settle as a soft
            // timeout so covered quantity is still protected downstream.
            const message =
              error instanceof Error ? error.message : String(error);
            console.warn(
              "OpenTrade reprice resubmit failed; settling as timeout",
              { token, message, repriceCount },
            );
            current = settled;
          }
        }
      }
      if (covered <= 0) {
        await this.store.transition(token, "cancelled", {
          closeReason: entryAbortReason,
          legs: [
            {
              exchangeId: preview.limitExchange,
              side: limitSide === "buy" ? "long" : "short",
              status: "cancelled",
              closeReason: entryAbortReason,
              exitOrderId: activeLimit.id,
            },
            {
              exchangeId: preview.marketExchange,
              side: limitSide === "buy" ? "short" : "long",
              status: "cancelled",
              closeReason: entryAbortReason,
            },
          ],
        });
        console.warn("OpenTrade cancelled without fill", {
          token,
          orderId: activeLimit.id,
          finalStatus: current.status,
          reason: entryAbortReason,
        });
        const limitSideForNotice =
          preview.limitExchange === preview.shortExchange ? "sell" : "buy";
        await this.options.notifyLimitTimeout?.({
          token,
          message:
            entryAbortReason === "spread_inverted"
              ? `🛑 Entrada abortada en ${preview.limitExchange} ` +
                `(${limitSideForNotice} ${preview.quantityBase} ${preview.symbol}): ` +
                `perseguir el precio ya era pérdida segura (spread ejecutable invertido). ` +
                `Límite cancelado sin fill. ¿Reintentar?`
              : `⏱ Limit order en ${preview.limitExchange} (${limitSideForNotice} ` +
                `${preview.quantityBase} ${preview.symbol}) no se llenó en ` +
                `${this.options.limitTimeoutMs}ms y fue cancelada. ¿Reintentar?`,
        });
        return { outcome: "cancelled" as const };
      }
      const limitFillPrice =
        covered > 0
          ? formatDecimal(settledNotionalUsd / covered, 8)
          : undefined;
      const longEntry =
        preview.limitExchange === preview.longExchange
          ? limitFillPrice
          : marketFillPrice;
      const shortEntry =
        preview.limitExchange === preview.shortExchange
          ? limitFillPrice
          : marketFillPrice;
      if (!longEntry || !shortEntry)
        throw new Error("Cannot protect trade without confirmed fill prices");

      // Fill-price integrity (design D2): the order ack / order-history
      // provenance is authoritative and used directly. The whole-position
      // average is a documented fallback only — a blank, non-positive,
      // signed-size-derived (blended), or same-BTC-sanity-failing value
      // fails the protection step loudly instead of anchoring mis-priced
      // TP/SL orders.
      if (hedgeFillSource === "position_average") {
        const limitPriceUsd = limitFillPrice
          ? parseDecimal(limitFillPrice)
          : NaN;
        const hedgePriceUsd = marketFillPrice
          ? parseDecimal(marketFillPrice)
          : NaN;
        const corrupt =
          hedgeFillDerived ||
          !marketFillPrice ||
          marketFillPrice.trim() === "" ||
          !(hedgePriceUsd > 0);
        const sanityDeviationBps =
          !corrupt && limitPriceUsd > 0
            ? (Math.abs(hedgePriceUsd - limitPriceUsd) / limitPriceUsd) * 10_000
            : 0;
        if (corrupt || sanityDeviationBps > PROTECTION_TOLERANCE_BPS) {
          throw new ProtectionAnchorError(
            `Hedge fill price failed integrity check ` +
              `(source=position_average, derived=${hedgeFillDerived}, ` +
              `price=${marketFillPrice ?? "n/a"}, ` +
              `limitFill=${limitFillPrice}, ` +
              `deviationBps=${sanityDeviationBps.toFixed(1)}); ` +
              `refusing to anchor protection orders`,
          );
        }
      }

      // Farmed volume (design D6): both entry fills land in one
      // transition — the limit leg's settled notional (exact across
      // reprices), the hedge leg's qty × fill price, and the trade-level
      // sum — via monotonic coalesce+delta inside the transaction.
      await this.store.transition(token, "hedging", {
        filledNotionalUsdDelta: formatDecimal(
          settledNotionalUsd + hedgeNotionalUsd,
          8,
        ),
        legs: [
          {
            exchangeId: preview.limitExchange,
            side: limitSide === "buy" ? "long" : "short",
            filledNotionalUsdDelta: formatDecimal(settledNotionalUsd, 8),
          },
          {
            exchangeId: preview.marketExchange,
            side: marketSide === "buy" ? "long" : "short",
            filledNotionalUsdDelta: formatDecimal(hedgeNotionalUsd, 8),
          },
        ],
      });

      // Per-leg protection anchors (design D1): each leg's TP/SL is
      // anchored to ITS OWN fill price — long TP = longFill × (1+TP%),
      // long SL = longFill × (1−SL%); the short leg profits when price
      // falls, so its TP trigger sits BELOW its fill (×(1−SL%)) and its
      // SL trigger ABOVE it (×(1+TP%)). This replaces the old cross-anchor
      // where the short leg inherited the long leg's trigger levels.
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
      const shortTp = applyPercentChange(
        shortEntry,
        this.options.stopLossPercent,
        "down",
      );
      const shortSl = applyPercentChange(
        shortEntry,
        this.options.takeProfitPercent,
        "up",
      );
      assertProtectionAnchors({
        longEntryUsd: longEntry,
        shortEntryUsd: shortEntry,
        longTpUsd: longTp,
        longSlUsd: longSl,
        shortTpUsd: shortTp,
        shortSlUsd: shortSl,
        takeProfitPercent: this.options.takeProfitPercent,
        stopLossPercent: this.options.stopLossPercent,
      });

      // Fee-aware fill-time edge band (design D4): the band's inputs are
      // knowable exactly once, at fill. Keep the trade iff the expected
      // convergence still left in the captured spread covers the
      // round-trip breakeven (entry fees + exit fees + slippage) plus the
      // configured minimum profit; otherwise abort immediately.
      const limitFees = this.options.fees[preview.limitExchange];
      const marketFees = this.options.fees[preview.marketExchange];
      const limitNotionalUsd = settledNotionalUsd;
      const exitNotionalUsd = limitNotionalUsd + hedgeNotionalUsd;
      const entryFeesUsd =
        (limitNotionalUsd * parseDecimal(limitFees.makerBps) +
          hedgeNotionalUsd * parseDecimal(marketFees.takerBps)) /
        10_000;
      const exitFeesUsd =
        (limitNotionalUsd * parseDecimal(limitFees.takerBps) +
          hedgeNotionalUsd * parseDecimal(marketFees.takerBps)) /
        10_000;
      const slippageUsd =
        (exitNotionalUsd *
          parseDecimal(this.options.slippageBps ?? DEFAULT_SLIPPAGE_BPS)) /
        10_000;
      const breakevenUsd = entryFeesUsd + exitFeesUsd + slippageUsd;
      // Convergence still capturable at fills: the strategy is
      // long-the-cheap-venue / short-the-expensive-venue, so both legs
      // profit as the prices meet: (P − longEntry) + (shortEntry − P) =
      // shortEntry − longEntry. (Design D4 wrote max(0, longEntry −
      // shortEntry); that sign aborts every normally-filled trade and
      // contradicts the spec's keep scenario — see apply-progress
      // deviation #1.)
      const expectedConvergenceUsd = Math.max(
        0,
        parseDecimal(shortEntry) - parseDecimal(longEntry),
      );
      const capturedSpreadUsd = expectedConvergenceUsd;
      const minProfitUsd = parseDecimal(
        this.options.minProfitUsd ?? DEFAULT_MIN_PROFIT_USD,
      );
      const minEdgeUsd = breakevenUsd + minProfitUsd;
      const keepOpen = expectedConvergenceUsd >= minEdgeUsd;
      console.log("OpenTrade edge band evaluated", {
        token,
        capturedSpreadUsd,
        expectedConvergenceUsd,
        entryFeesUsd,
        exitFeesUsd,
        slippageUsd,
        breakevenUsd,
        minProfitUsd,
        minEdgeUsd,
        keepOpen,
      });
      if (!keepOpen) {
        console.warn("OpenTrade edge below cost; closing both legs at market", {
          token,
          capturedSpreadUsd,
          expectedConvergenceUsd,
          breakevenUsd,
          minEdgeUsd,
        });
        const coveredQuantityBase = formatDecimal(covered, 10);
        const close = await closeTradeBothLegs({
          store: this.store,
          registry: this.registry,
          token,
          symbol: preview.symbol,
          longExchange: preview.longExchange,
          shortExchange: preview.shortExchange,
          legs: [
            {
              exchangeId: preview.longExchange,
              side: "long",
              quantityBase: coveredQuantityBase,
              entryPriceUsd: longEntry,
              raw: undefined,
            },
            {
              exchangeId: preview.shortExchange,
              side: "short",
              quantityBase: coveredQuantityBase,
              entryPriceUsd: shortEntry,
              raw: undefined,
            },
          ],
          reason: "edge_below_cost",
          notify: (text) =>
            this.options.notifyUrgent?.(text) ?? Promise.resolve(),
        });
        // Runtime assertion (design D4): the abort loss is structurally
        // bounded by fees + slippage ≪ maxLossUsd; an exceedance means the
        // fee model drifted. Log + notify but do not throw — the trade is
        // already closed.
        if (close.realizedPnlUsd != null) {
          const maxLossUsd = parseDecimal(
            this.options.maxLossUsd ?? DEFAULT_MAX_LOSS_USD,
          );
          const abortLossUsd = Math.abs(parseDecimal(close.realizedPnlUsd));
          if (abortLossUsd > maxLossUsd) {
            console.error(
              "OpenTrade edge abort exceeded max loss bound (fee-model drift detected)",
              { token, realizedPnlUsd: close.realizedPnlUsd, maxLossUsd },
            );
            await this.options.notifyUrgent?.(
              `🚨 fee-model drift detected: edge_below_cost close on ` +
                `${token.slice(0, 8)} realized $${abortLossUsd.toFixed(2)} ` +
                `(max loss bound $${maxLossUsd.toFixed(2)}). Check the ` +
                `configured fee bps against the venues' actual fees.`,
            );
          }
        }
        return {
          outcome: "edge_closed" as const,
          realizedPnlUsd: close.realizedPnlUsd,
          capturedSpreadUsd,
          minEdgeUsd,
        };
      }

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
        shortTp,
        shortSl,
        protectionOrderIds,
      );
      console.log("OpenTrade protection submitted", {
        token,
        coveredQuantityBase: formatDecimal(covered, 10),
        longTp,
        longSl,
        shortTp,
        shortSl,
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
              tpTriggerUsd: shortTp,
              slTriggerUsd: shortSl,
            },
          },
        ],
      });
      console.log("OpenTrade confirm completed", {
        token,
        coveredQuantityBase: formatDecimal(covered, 10),
        longTp,
        longSl,
        shortTp,
        shortSl,
      });
      return { outcome: "opened" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("OpenTrade confirm failed", {
        token,
        coveredQuantityBase: formatDecimal(covered, 10),
        limitOrder,
        message,
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
      const [bbo, meta] = await Promise.all([
        input.adapter.getBestBidOffer({
          symbol: input.symbol,
          marketType: "perpetual",
          priceSource: "last",
        }),
        input.adapter.getMarketMetadata({
          symbol: input.symbol,
          marketType: "perpetual",
          priceSource: "last",
        }),
      ]);
      const priceUsd = this.passiveLimitPriceFromBbo(
        bbo,
        input.side,
        meta.priceTickUsd,
      );
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
          priceTickUsd: meta.priceTickUsd,
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
    priceTickUsd?: string,
  ): string {
    const ticks = this.options.entryImproveTicks ?? DEFAULT_ENTRY_IMPROVE_TICKS;
    const tick = priceTickUsd?.trim() ?? "";
    if (ticks === 0 || tick === "")
      return side === "buy" ? bbo.bidUsd : bbo.askUsd;
    const shift = multiplyDecimalString(tick, ticks);
    if (side === "buy") {
      const candidate = addDecimalStrings(bbo.bidUsd, shift);
      // Strictly below the ask keeps the order post-only.
      if (compareDecimalStrings(candidate, bbo.askUsd) < 0) return candidate;
      return bbo.bidUsd;
    }
    const candidate = subtractDecimalStrings(bbo.askUsd, shift);
    // Strictly above the bid keeps the order post-only.
    if (compareDecimalStrings(candidate, bbo.bidUsd) > 0) return candidate;
    return bbo.askUsd;
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
  /** Re-reads an order after a cancel with bounded retries, tolerating the
   * venue's read-after-write lag (Extended briefly 404s on recent orders).
   * Returns the observed state with the highest filled quantity — a fill can
   * land between the cancel request and the first read. Falls back to the
   * pre-cancel state only if every re-poll fails (same tolerance as the main
   * polling loop: a transient read failure must not kill the trade). */
  private async readOrderAfterCancel(
    adapter: ExecutionAdapter,
    orderId: string,
    fallback: Awaited<ReturnType<ExecutionAdapter["getExecutionOrder"]>>,
  ): Promise<Awaited<ReturnType<ExecutionAdapter["getExecutionOrder"]>>> {
    let best:
      | Awaited<ReturnType<ExecutionAdapter["getExecutionOrder"]>>
      | undefined;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        const latest = await adapter.getExecutionOrder(orderId);
        const latestFilled = parseDecimal(latest.filledQuantityBase);
        const bestFilled = best ? parseDecimal(best.filledQuantityBase) : -1;
        // Prefer the highest fill; on ties prefer a snapshot that carries the
        // average fill price, else the hedge step would abort loudly.
        if (
          latestFilled > bestFilled ||
          (latestFilled === bestFilled &&
            !best?.averageFillPriceUsd &&
            latest.averageFillPriceUsd)
        )
          best = latest;
        if (latest.status === "filled") break;
      } catch (error) {
        console.warn("OpenTrade post-cancel order re-poll failed", {
          orderId,
          attempt,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      await this.sleep(500);
    }
    if (!best) {
      console.warn(
        "OpenTrade post-cancel order re-poll exhausted; keeping pre-cancel state",
        { orderId },
      );
      return fallback;
    }
    return best;
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

// Exact decimal-string arithmetic (BigInt-scaled, no float math): prices like
// 94200.3 + 0.1 must stay exact. Results keep the input scale with trailing
// zeros trimmed.
function decimalScaleOf(value: string): number {
  const dot = value.indexOf(".");
  return dot === -1 ? 0 : value.length - dot - 1;
}

function toScaledBigInt(value: string): { scaled: bigint; scale: number } {
  const trimmed = value.trim();
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const digits = unsigned.replace(".", "");
  if (digits !== "" && !/^\d+$/.test(digits))
    throw new Error(`Invalid decimal price: ${value}`);
  return {
    scaled: BigInt((negative ? "-" : "") + (digits === "" ? "0" : digits)),
    scale: decimalScaleOf(trimmed),
  };
}

function alignScales(
  left: { scaled: bigint; scale: number },
  right: { scaled: bigint; scale: number },
): { left: bigint; right: bigint; scale: number } {
  const scale = Math.max(left.scale, right.scale);
  return {
    left: left.scaled * 10n ** BigInt(scale - left.scale),
    right: right.scaled * 10n ** BigInt(scale - right.scale),
    scale,
  };
}

function formatScaledBigInt(scaled: bigint, scale: number): string {
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled)
    .toString()
    .padStart(scale + 1, "0");
  const sign = negative ? "-" : "";
  if (scale === 0) return sign + digits;
  const intPart = digits.slice(0, -scale);
  const fracPart = digits.slice(-scale).replace(/0+$/, "");
  return fracPart === "" ? sign + intPart : `${sign}${intPart}.${fracPart}`;
}

function addDecimalStrings(left: string, right: string): string {
  const aligned = alignScales(toScaledBigInt(left), toScaledBigInt(right));
  return formatScaledBigInt(aligned.left + aligned.right, aligned.scale);
}

function subtractDecimalStrings(left: string, right: string): string {
  const aligned = alignScales(toScaledBigInt(left), toScaledBigInt(right));
  return formatScaledBigInt(aligned.left - aligned.right, aligned.scale);
}

function multiplyDecimalString(value: string, factor: number): string {
  const scaled = toScaledBigInt(value);
  if (!Number.isInteger(factor) || factor < 0)
    throw new Error(`Invalid tick factor: ${factor}`);
  return formatScaledBigInt(scaled.scaled * BigInt(factor), scaled.scale);
}

function compareDecimalStrings(left: string, right: string): number {
  const aligned = alignScales(toScaledBigInt(left), toScaledBigInt(right));
  if (aligned.left < aligned.right) return -1;
  if (aligned.left > aligned.right) return 1;
  return 0;
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
