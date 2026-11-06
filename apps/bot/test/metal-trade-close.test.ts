import assert from "node:assert/strict";
import test from "node:test";
import type { BotConfig } from "@btc-arbitrage/config";
import { tradeLegs, trades } from "@btc-arbitrage/db";
import { ExecutionMode } from "@btc-arbitrage/domain";
import type {
  BestBidOffer,
  ExecutionAdapter,
  ExecutionOrder,
  ExecutionOrderRequest,
  MarketMetadata,
} from "@btc-arbitrage/exchange-core";
import {
  closeMetalTrade,
  type MetalTradeContext,
} from "../src/metal-ratio/metal-trade-service.js";
import { GOLD_MARKET, SILVER_MARKET } from "../src/metal-ratio/metal-ratio-warmup.js";
import {
  createFakeDrizzleDb,
  type FakeDrizzleDb,
} from "./helpers/fake-drizzle.js";

// Deterministic market picture for the CLOSE (prices moved since the
// entry at GLD $2400 / SLV $30 so the PnL is non-zero): a short-gold
// close BUYS back at the $2381 ask, a long-silver close SELLS at the
// $30.10 bid.
const GOLD_BBO = { bidUsd: "2380", askUsd: "2381" };
const SILVER_BBO = { bidUsd: "30.10", askUsd: "30.11" };
const GOLD_META: MarketMetadata = {
  minQuantityBase: "0.0001",
  quantityStepBase: "0.0001",
  priceTickUsd: "1",
};
const SILVER_META: MarketMetadata = {
  minQuantityBase: "0.01",
  quantityStepBase: "0.01",
  priceTickUsd: "0.01",
};

const MARKET_CLOSE_FEE = "0.02";
const LIMIT_CLOSE_FEE = "0.01";

interface FakeCloseExecutionOptions {
  goldBbo?: { bidUsd: string; askUsd: string };
  silverBbo?: { bidUsd: string; askUsd: string };
  /** Symbols whose reduce-only LIMIT orders never fill (stay "new") —
   * drives the budget-exhaustion fallback. */
  neverFillLimitSymbols?: ReadonlySet<string>;
  /** Order ids whose cancelExecutionOrder throws (disaster-stop cancel
   * failure path). */
  failCancelIds?: ReadonlySet<string>;
}

type FakeEvent =
  | { kind: "submit"; input: ExecutionOrderRequest }
  | { kind: "cancel"; orderId: string; market?: string };

function bbo(values: { bidUsd: string; askUsd: string }): BestBidOffer {
  return { ...values, receivedAt: new Date() };
}

function fakeCloseExecution(options: FakeCloseExecutionOptions = {}) {
  const goldBbo = options.goldBbo ?? GOLD_BBO;
  const silverBbo = options.silverBbo ?? SILVER_BBO;
  const calls: ExecutionOrderRequest[] = [];
  const cancels: Array<{ orderId: string; market?: string }> = [];
  const events: FakeEvent[] = [];
  const states = new Map<string, () => ExecutionOrder>();
  let sequence = 0;

  const register = (order: ExecutionOrder) => {
    states.set(order.id, () => order);
    return order;
  };

  const execution: ExecutionAdapter = {
    getBestBidOffer: async ({ symbol }) =>
      bbo(symbol === GOLD_MARKET ? goldBbo : silverBbo),
    getMarketMetadata: async ({ symbol }) =>
      symbol === GOLD_MARKET ? GOLD_META : SILVER_META,
    getAvailableMarginUsd: async () => "10000",
    validateExecutionPreflight: async () => undefined,
    submitExecutionOrder: async (input) => {
      calls.push(input);
      events.push({ kind: "submit", input });
      sequence += 1;
      const id = `ord-${sequence}`;
      const bboForSymbol = input.symbol === GOLD_MARKET ? goldBbo : silverBbo;
      if (input.type === "limit") {
        if (options.neverFillLimitSymbols?.has(input.symbol)) {
          // Resting limit that never fills (budget-exhaustion driver).
          register({ id, status: "new", filledQuantityBase: "0" });
        } else {
          // Reduce-only close limit: immediate full fill at its price.
          register({
            id,
            status: "filled",
            filledQuantityBase: input.quantityBase,
            averageFillPriceUsd: input.priceUsd,
            feeUsd: LIMIT_CLOSE_FEE,
          });
        }
      } else {
        // Reduce-only market close: fills at the touch (buy lifts the
        // ask, sell hits the bid).
        register({
          id,
          status: "filled",
          filledQuantityBase: input.quantityBase,
          averageFillPriceUsd:
            input.side === "buy" ? bboForSymbol.askUsd : bboForSymbol.bidUsd,
          feeUsd: MARKET_CLOSE_FEE,
        });
      }
      return { id, status: "new", filledQuantityBase: "0" };
    },
    getExecutionOrder: async (orderId) =>
      states.get(orderId)?.() ?? {
        id: orderId,
        status: "cancelled",
        filledQuantityBase: "0",
      },
    cancelExecutionOrder: async (orderId, market) => {
      cancels.push({ orderId, market });
      events.push({ kind: "cancel", orderId, market });
      if (options.failCancelIds?.has(orderId)) {
        throw new Error(`cancel rejected for ${orderId}`);
      }
      const current = states.get(orderId)?.();
      if (current) states.set(orderId, () => ({ ...current, status: "cancelled" }));
    },
    getPosition: async () => null,
  };
  return { execution, calls, cancels, events };
}

function metalConfig(goldSilverOverrides: Record<string, unknown> = {}) {
  return {
    botExecutionMode: ExecutionMode.DryRun,
    arcus: {
      apiBaseUrl: "https://example.invalid",
      makerFeeBps: 1,
      takerFeeBps: 3,
    },
    goldSilver: {
      marginUsd: "20",
      leverage: 3,
      limitTimeoutMs: 5000,
      limitRepriceIntervalMs: 2000,
      entryImproveTicks: 1,
      stopLossMarginPercent: 50,
      tpMinNetUsd: "0.05",
      exitRepriceIntervalMs: 2000,
      exitSlippageBudgetBps: 40,
      exitMaxWaitMs: 60000,
      exitMaxReprices: 8,
      timeStopHours: 48,
      maxEntrySlippageBps: 40,
      hedgeRetryAttempts: 3,
      ...goldSilverOverrides,
    },
  } as unknown as BotConfig;
}

function makeContext(
  db: FakeDrizzleDb,
  execution: ExecutionAdapter,
  config: BotConfig = metalConfig(),
) {
  const notifications: string[] = [];
  const urgentNotifications: string[] = [];
  const ctx: MetalTradeContext = {
    db: db as unknown as MetalTradeContext["db"],
    config,
    execution,
    notify: async (text) => {
      notifications.push(text);
    },
    notifyUrgent: async (text) => {
      urgentNotifications.push(text);
    },
  };
  return { ctx, notifications, urgentNotifications };
}

/** Seeds the open short-gold/long-silver trade the entry flow would have
 * produced (trade #7, legs #71 GLD short / #72 SLV long, disaster stops
 * resting with their ids in raw). */
function seedOpenMetalTrade(
  db: FakeDrizzleDb,
  options: {
    tradeStatus?: string;
    goldLeg?: Record<string, unknown>;
    silverLeg?: Record<string, unknown>;
  } = {},
) {
  db.seed(trades, [
    {
      id: 7,
      symbol: "GOLDSILVER",
      marketType: "perpetual",
      priceSource: "mark",
      mode: "dry-run",
      status: options.tradeStatus ?? "open",
      longExchange: "arcus",
      shortExchange: "arcus",
      leverage: 3,
      filledNotionalUsd: "120",
      openedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);
  db.seed(tradeLegs, [
    {
      id: 71,
      tradeId: 7,
      exchangeId: "arcus",
      side: "short",
      status: "open",
      quantityBase: "0.025",
      quantityUsd: "60",
      entryPriceUsd: "2400",
      entryFeeUsd: "0",
      raw: { market: GOLD_MARKET, slOrderId: "sl-gold-71" },
      ...options.goldLeg,
    },
    {
      id: 72,
      tradeId: 7,
      exchangeId: "arcus",
      side: "long",
      status: "open",
      quantityBase: "2",
      quantityUsd: "60",
      entryPriceUsd: "30",
      entryFeeUsd: "0.05",
      raw: { market: SILVER_MARKET, slOrderId: "sl-silver-72" },
      ...options.silverLeg,
    },
  ]);
}

const marketCloseCalls = (calls: ExecutionOrderRequest[]) =>
  calls.filter((call) => call.type === "market" && call.reduceOnly);
const limitCloseCalls = (calls: ExecutionOrderRequest[]) =>
  calls.filter((call) => call.type === "limit" && call.reduceOnly);

const approx = (actual: unknown, expected: number, tolerance = 1e-6) => {
  assert.ok(
    Math.abs(Number(actual) - expected) < tolerance,
    `expected ~${expected}, got ${String(actual)}`,
  );
};

// ---------- closeMetalTrade: market mode ----------

test("market close cancels both disaster stops BEFORE the reduce-only market closes and finalizes gross/fees/net", async () => {
  const db = createFakeDrizzleDb();
  seedOpenMetalTrade(db);
  const { execution, calls, cancels, events } = fakeCloseExecution();
  const { ctx, notifications, urgentNotifications } = makeContext(db, execution);
  // >32 chars to pin the closeReason truncation to the 32-char column.
  const reason = "manual_close_operator_escape_hatch_button";
  await closeMetalTrade(ctx, 7, reason, "market");

  // Disaster stops cancelled for BOTH legs, before ANY close order was
  // submitted, with the per-leg market hint from raw.
  assert.equal(cancels.length, 2);
  assert.deepEqual(
    cancels.find((cancel) => cancel.orderId === "sl-gold-71"),
    { orderId: "sl-gold-71", market: GOLD_MARKET },
  );
  assert.deepEqual(
    cancels.find((cancel) => cancel.orderId === "sl-silver-72"),
    { orderId: "sl-silver-72", market: SILVER_MARKET },
  );
  const firstSubmitIndex = events.findIndex((event) => event.kind === "submit");
  const cancelIndices = events
    .map((event, index) => (event.kind === "cancel" ? index : -1))
    .filter((index) => index >= 0);
  assert.ok(firstSubmitIndex >= 0);
  assert.ok(cancelIndices.every((index) => index < firstSubmitIndex));

  // Reduce-only market closes with the CLOSE side (short => buy back,
  // long => sell), the leg markets and full quantities.
  const closes = marketCloseCalls(calls);
  assert.equal(closes.length, 2);
  const goldClose = closes.find((call) => call.symbol === GOLD_MARKET)!;
  const silverClose = closes.find((call) => call.symbol === SILVER_MARKET)!;
  assert.equal(goldClose.side, "buy");
  assert.equal(goldClose.quantityBase, "0.025");
  assert.equal(silverClose.side, "sell");
  assert.equal(silverClose.quantityBase, "2");
  assert.equal(limitCloseCalls(calls).length, 0);

  // Legs: closed with exit price at the touch, exit fee, GROSS realized
  // PnL, truncated closeReason, closedAt.
  const gold = db.rows(tradeLegs).find((leg) => leg.id === 71)!;
  const silver = db.rows(tradeLegs).find((leg) => leg.id === 72)!;
  assert.equal(gold.status, "closed");
  assert.equal(gold.exitPriceUsd, "2381");
  assert.equal(gold.exitFeeUsd, MARKET_CLOSE_FEE);
  // short: (-1) x (2381 - 2400) x 0.025 = +0.475 gross.
  assert.equal(gold.realizedPnlUsd, "0.475");
  assert.equal(gold.closeReason, reason.slice(0, 32));
  assert.ok(gold.closeReason.length <= 32);
  assert.ok(gold.closedAt instanceof Date);
  assert.equal(silver.status, "closed");
  assert.equal(silver.exitPriceUsd, "30.1");
  assert.equal(silver.exitFeeUsd, MARKET_CLOSE_FEE);
  // long: (+1) x (30.10 - 30) x 2 = +0.20 gross.
  approx(silver.realizedPnlUsd, 0.2);
  assert.equal(silver.closeReason, reason.slice(0, 32));

  // Trade: closed with gross realized, summed fees (entry + exit) and
  // filled notional.
  const trade = db.rows(trades)[0]!;
  assert.equal(trade.status, "closed");
  approx(trade.realizedPnlUsd, 0.675);
  // fees = gold (0 + 0.02) + silver (0.05 + 0.02) = 0.09.
  approx(trade.totalFeesUsd, 0.09);
  approx(trade.filledNotionalUsd, 120);
  assert.ok(trade.closedAt instanceof Date);

  // Final notify: CLOSED + full reason + Gross/Fees/Net breakdown.
  const closed = notifications.find((text) => text.includes("CLOSED"));
  assert.ok(closed);
  assert.ok(closed.includes(reason));
  assert.ok(closed.includes("Gross PnL"));
  assert.ok(closed.includes("Fees"));
  assert.ok(closed.includes("Net"));
  assert.equal(urgentNotifications.length, 0);
  assert.equal(db.unparsedConditions.length, 0);
});

test("market close is a no-op when the trade is already closing (claim race lost)", async () => {
  const db = createFakeDrizzleDb();
  seedOpenMetalTrade(db, { tradeStatus: "closing" });
  const { execution, calls, cancels } = fakeCloseExecution();
  const { ctx, notifications, urgentNotifications } = makeContext(db, execution);
  await closeMetalTrade(ctx, 7, "sl_stop_loss", "market");

  assert.equal(calls.length, 0);
  assert.equal(cancels.length, 0);
  assert.equal(notifications.length, 0);
  assert.equal(urgentNotifications.length, 0);
  assert.equal(db.rows(trades)[0]!.status, "closing");
  assert.deepEqual(
    db.rows(tradeLegs).map((leg) => leg.status),
    ["open", "open"],
  );
  assert.equal(db.unparsedConditions.length, 0);
});

test("close is a no-op for a trade still entering and for a missing trade row", async () => {
  const db = createFakeDrizzleDb();
  seedOpenMetalTrade(db, { tradeStatus: "executing_limit" });
  const { execution, calls, cancels } = fakeCloseExecution();
  const { ctx, notifications } = makeContext(db, execution);
  await closeMetalTrade(ctx, 7, "manual_close", "market");
  assert.equal(calls.length, 0);
  assert.equal(cancels.length, 0);
  assert.equal(notifications.length, 0);
  assert.equal(db.rows(trades)[0]!.status, "executing_limit");

  const emptyDb = createFakeDrizzleDb();
  const second = fakeCloseExecution();
  const { ctx: emptyCtx, notifications: emptyNotifications } = makeContext(
    emptyDb,
    second.execution,
  );
  await closeMetalTrade(emptyCtx, 999, "manual_close", "market");
  assert.equal(second.calls.length, 0);
  assert.equal(second.cancels.length, 0);
  assert.equal(emptyNotifications.length, 0);
  assert.equal(emptyDb.unparsedConditions.length, 0);
});

test("unhedged trade: only the still-open leg is market-closed; the already-closed leg gets no order", async () => {
  const db = createFakeDrizzleDb();
  // The position monitor already closed the gold leg (disaster stop
  // fired) and flipped the trade to unhedged.
  seedOpenMetalTrade(db, {
    tradeStatus: "unhedged",
    goldLeg: {
      status: "closed",
      exitPriceUsd: "2420",
      exitFeeUsd: "0.02",
      realizedPnlUsd: "-0.5",
      closeReason: "disaster_stop_fired",
      closedAt: new Date(),
    },
  });
  const { execution, calls, cancels } = fakeCloseExecution();
  const { ctx, notifications, urgentNotifications } = makeContext(db, execution);
  await closeMetalTrade(ctx, 7, "manual_close", "market");

  // BOTH disaster stops are still cancelled (the cancel pass is over all
  // legs, not only open ones), but only ONE close order: the silver leg.
  assert.equal(cancels.length, 2);
  const closes = marketCloseCalls(calls);
  assert.equal(closes.length, 1);
  assert.equal(closes[0]!.symbol, SILVER_MARKET);
  assert.equal(closes[0]!.side, "sell");
  assert.equal(closes[0]!.quantityBase, "2");

  const silver = db.rows(tradeLegs).find((leg) => leg.id === 72)!;
  assert.equal(silver.status, "closed");
  assert.equal(silver.exitPriceUsd, "30.1");
  approx(silver.realizedPnlUsd, 0.2);

  // KNOWN BUG (reported, not fixed): finalizeClosedTrade rewrites EVERY
  // leg row, and a leg without a recorded exit is marked "failed" with
  // its stored close data WIPED — the already-closed gold leg loses its
  // monitor-recorded exitPriceUsd 2420 / realizedPnlUsd -0.5 / exit fee,
  // and the trade-level realized PnL excludes the gold leg's loss.
  const gold = db.rows(tradeLegs).find((leg) => leg.id === 71)!;
  assert.equal(gold.status, "failed");
  assert.equal(gold.exitPriceUsd, null);
  assert.equal(gold.exitFeeUsd, "0");
  assert.equal(gold.realizedPnlUsd, "0");
  const trade = db.rows(trades)[0]!;
  assert.equal(trade.status, "closed");
  approx(trade.realizedPnlUsd, 0.2); // silver leg only — gold's -0.5 lost

  assert.ok(notifications.some((text) => text.includes("CLOSED")));
  assert.equal(urgentNotifications.length, 0);
  assert.equal(db.unparsedConditions.length, 0);
});

test("a disaster-stop cancel failure only warns and never blocks the close", async () => {
  const db = createFakeDrizzleDb();
  seedOpenMetalTrade(db);
  const { execution, calls, cancels } = fakeCloseExecution({
    failCancelIds: new Set(["sl-gold-71"]),
  });
  const { ctx, notifications, urgentNotifications } = makeContext(db, execution);
  await closeMetalTrade(ctx, 7, "manual_close", "market");

  // Both cancels were attempted; the gold one threw, but the close
  // orders were still submitted for both legs.
  assert.equal(cancels.length, 2);
  assert.equal(marketCloseCalls(calls).length, 2);
  assert.equal(db.rows(trades)[0]!.status, "closed");
  assert.deepEqual(
    db.rows(tradeLegs).map((leg) => leg.status),
    ["closed", "closed"],
  );
  assert.ok(notifications.some((text) => text.includes("CLOSED")));
  assert.equal(urgentNotifications.length, 0);
  assert.equal(db.unparsedConditions.length, 0);
});

// ---------- closeMetalTrade: limit mode ----------

test("limit close rests reduce-only dual limits at the touch and closes both legs on fills", async () => {
  const db = createFakeDrizzleDb();
  seedOpenMetalTrade(db);
  const { execution, calls, cancels } = fakeCloseExecution();
  const { ctx, notifications, urgentNotifications } = makeContext(db, execution);
  await closeMetalTrade(ctx, 7, "tp_hit", "limit");

  // Disaster stops cancelled first, then one reduce-only limit per leg
  // at the touch: short gold BUYS at the ask ($2381, tick $1), long
  // silver SELLS at the bid ($30.10, tick $0.01).
  assert.equal(cancels.length, 2);
  const limits = limitCloseCalls(calls);
  assert.equal(limits.length, 2);
  const goldLimit = limits.find((call) => call.symbol === GOLD_MARKET)!;
  const silverLimit = limits.find((call) => call.symbol === SILVER_MARKET)!;
  assert.equal(goldLimit.side, "buy");
  assert.equal(goldLimit.reduceOnly, true);
  assert.equal(goldLimit.quantityBase, "0.025");
  assert.equal(goldLimit.priceUsd, "2381");
  assert.equal(silverLimit.side, "sell");
  assert.equal(silverLimit.reduceOnly, true);
  assert.equal(silverLimit.quantityBase, "2");
  assert.equal(silverLimit.priceUsd, "30.1");
  // No market fallback was needed.
  assert.equal(marketCloseCalls(calls).length, 0);

  // Legs closed at the limit fill prices with the limit fee.
  const gold = db.rows(tradeLegs).find((leg) => leg.id === 71)!;
  const silver = db.rows(tradeLegs).find((leg) => leg.id === 72)!;
  assert.equal(gold.status, "closed");
  assert.equal(gold.exitPriceUsd, "2381");
  assert.equal(gold.exitFeeUsd, LIMIT_CLOSE_FEE);
  assert.equal(gold.realizedPnlUsd, "0.475");
  assert.equal(silver.status, "closed");
  assert.equal(silver.exitPriceUsd, "30.1");
  assert.equal(silver.exitFeeUsd, LIMIT_CLOSE_FEE);
  approx(silver.realizedPnlUsd, 0.2);

  const trade = db.rows(trades)[0]!;
  assert.equal(trade.status, "closed");
  approx(trade.realizedPnlUsd, 0.675);
  // fees = gold (0 + 0.01) + silver (0.05 + 0.01) = 0.07.
  approx(trade.totalFeesUsd, 0.07);
  approx(trade.filledNotionalUsd, 120);

  const closed = notifications.find((text) => text.includes("CLOSED"));
  assert.ok(closed);
  assert.ok(closed.includes("tp_hit"));
  assert.ok(closed.includes("Gross PnL"));
  assert.ok(closed.includes("Fees"));
  assert.ok(closed.includes("Net"));
  assert.equal(urgentNotifications.length, 0);
  assert.equal(db.unparsedConditions.length, 0);
});

test("limit close falls back to market for the unfilled remainder when the budget exhausts", async () => {
  const db = createFakeDrizzleDb();
  seedOpenMetalTrade(db);
  const { execution, calls, cancels } = fakeCloseExecution({
    neverFillLimitSymbols: new Set([SILVER_MARKET]),
  });
  // exitMaxWaitMs 0 exhausts the wait budget on the first management
  // pass after the gold leg fills — deterministic, no sleeps.
  const { ctx, notifications, urgentNotifications } = makeContext(
    db,
    execution,
    metalConfig({ exitMaxWaitMs: 0 }),
  );
  await closeMetalTrade(ctx, 7, "tp_hit", "limit");

  // Exactly the two initial limits (no reprice cancel/replace round)...
  const limits = limitCloseCalls(calls);
  assert.equal(limits.length, 2);
  assert.equal(cancels.length, 2); // only the disaster stops
  // ...then the silver remainder is market-closed (reduce-only sell of
  // the full 2 SLV).
  const markets = marketCloseCalls(calls);
  assert.equal(markets.length, 1);
  assert.equal(markets[0]!.symbol, SILVER_MARKET);
  assert.equal(markets[0]!.side, "sell");
  assert.equal(markets[0]!.quantityBase, "2");

  // Gold closed at its limit fill; silver closed at the market touch.
  const gold = db.rows(tradeLegs).find((leg) => leg.id === 71)!;
  const silver = db.rows(tradeLegs).find((leg) => leg.id === 72)!;
  assert.equal(gold.status, "closed");
  assert.equal(gold.exitPriceUsd, "2381");
  assert.equal(gold.exitFeeUsd, LIMIT_CLOSE_FEE);
  assert.equal(silver.status, "closed");
  assert.equal(silver.exitPriceUsd, "30.1");
  assert.equal(silver.exitFeeUsd, MARKET_CLOSE_FEE);
  approx(silver.realizedPnlUsd, 0.2);
  assert.equal(db.rows(trades)[0]!.status, "closed");

  // The operator is told about the budget-exhaustion market fallback.
  assert.ok(
    notifications.some((text) =>
      text.includes("closing the remainder at MARKET"),
    ),
  );
  assert.ok(notifications.some((text) => text.includes("CLOSED")));
  assert.equal(urgentNotifications.length, 0);
  assert.equal(db.unparsedConditions.length, 0);
});
