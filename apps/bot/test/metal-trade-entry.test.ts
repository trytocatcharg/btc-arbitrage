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
  OrderBookDepth,
} from "@btc-arbitrage/exchange-core";
import {
  createMetalTrade,
  executeMetalTradeEntry,
  type MetalTradeContext,
} from "../src/metal-ratio/metal-trade-service.js";
import { GOLD_MARKET, SILVER_MARKET } from "../src/metal-ratio/metal-ratio-warmup.js";
import {
  createFakeDrizzleDb,
  type FakeDrizzleDb,
} from "./helpers/fake-drizzle.js";

// Deterministic market picture: GLD ~$2400 (tick $1), SLV ~$30 (tick
// $0.01). Margin $20 x leverage 3 = $60 notional per leg => goldQty
// 0.025, silverQty 2 (dollar-neutral, gold qty always the smaller).
const GOLD_BBO = { bidUsd: "2399", askUsd: "2400" };
const SILVER_BBO = { bidUsd: "29.99", askUsd: "30" };
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
/** Tight, deep SLV book: book-walk drag ~3.3 bps + 3 taker + 1 maker fee
 * stays well under the 40 bps gate. */
const DEEP_BOOK: OrderBookDepth = {
  bids: [{ priceUsd: "29.99", sizeBase: "5" }],
  asks: [{ priceUsd: "30.01", sizeBase: "5" }],
  receivedAt: new Date(),
};

interface HedgeScript {
  status: "filled" | "cancelled" | "rejected";
  filledQuantityBase: string;
  averageFillPriceUsd?: string;
  feeUsd?: string;
}

interface FakeExecutionOptions {
  goldBbo?: { bidUsd: string; askUsd: string };
  silverBbo?: { bidUsd: string; askUsd: string };
  depth?: OrderBookDepth;
  /** Omit getOrderBookDepth entirely (the adapter "lacks" it). */
  noDepth?: boolean;
  /** Times the depth read throws before returning the scripted book. */
  depthFailures?: number;
  /** Terminal states for the SLV hedge market orders, in submit order;
   * the last entry repeats once the script runs out. */
  hedgeFills?: HedgeScript[];
  /** Message thrown by the FIRST GLD limit submission (post-only retry). */
  firstLimitRejection?: string;
}

function bbo(values: { bidUsd: string; askUsd: string }): BestBidOffer {
  return { ...values, receivedAt: new Date() };
}

function fakeMetalExecution(options: FakeExecutionOptions = {}) {
  const goldBbo = options.goldBbo ?? GOLD_BBO;
  const silverBbo = options.silverBbo ?? SILVER_BBO;
  const calls: ExecutionOrderRequest[] = [];
  const cancels: Array<{ orderId: string; market?: string }> = [];
  const states = new Map<string, () => ExecutionOrder>();
  let sequence = 0;
  let hedgeIndex = 0;
  let depthCalls = 0;
  let limitRejectionsLeft = options.firstLimitRejection ? 1 : 0;

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
      sequence += 1;
      const id = `ord-${sequence}`;
      if (
        input.type === "limit" &&
        input.symbol === GOLD_MARKET &&
        !input.reduceOnly &&
        limitRejectionsLeft > 0
      ) {
        limitRejectionsLeft -= 1;
        throw new Error(options.firstLimitRejection!);
      }
      if (input.type === "limit") {
        // Resting GLD limit: report a full immediate fill at its price.
        register({
          id,
          status: "filled",
          filledQuantityBase: input.quantityBase,
          averageFillPriceUsd: input.priceUsd,
        });
      } else if (input.type === "stop-market") {
        // Disaster stops: resting ("new") so the verify read passes.
        register({ id, status: "new", filledQuantityBase: "0" });
      } else if (input.reduceOnly) {
        // Emergency rollback closes fill immediately at the touch.
        register({
          id,
          status: "filled",
          filledQuantityBase: input.quantityBase,
          averageFillPriceUsd:
            input.symbol === GOLD_MARKET ? goldBbo.bidUsd : silverBbo.askUsd,
        });
      } else {
        // SLV hedge market IOC: scripted terminal states.
        const script = options.hedgeFills?.[
          Math.min(hedgeIndex, (options.hedgeFills?.length ?? 1) - 1)
        ] ?? {
          status: "filled" as const,
          filledQuantityBase: input.quantityBase,
          averageFillPriceUsd: silverBbo.askUsd,
          feeUsd: "0.05",
        };
        hedgeIndex += 1;
        register({ id, ...script });
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
      const current = states.get(orderId)?.();
      if (current) states.set(orderId, () => ({ ...current, status: "cancelled" }));
    },
    getPosition: async () => null,
  };
  if (!options.noDepth) {
    execution.getOrderBookDepth = async () => {
      depthCalls += 1;
      if (depthCalls <= (options.depthFailures ?? 0)) {
        throw new Error("depth endpoint 502");
      }
      return options.depth ?? DEEP_BOOK;
    };
  }
  return {
    execution,
    calls,
    cancels,
    depthCallCount: () => depthCalls,
  };
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

/** Seeds the trade + legs createMetalTrade would have inserted for a
 * short-gold/long-silver entry (trade #7, legs #71 GLD / #72 SLV). */
function seedExecutingEntry(db: FakeDrizzleDb, tradeStatus = "executing_limit") {
  db.seed(trades, [
    {
      id: 7,
      symbol: "GOLDSILVER",
      marketType: "perpetual",
      priceSource: "mark",
      mode: "dry-run",
      status: tradeStatus,
      longExchange: "arcus",
      shortExchange: "arcus",
      leverage: 3,
      filledNotionalUsd: "0",
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
      status: "planned",
      quantityBase: "0.025",
      quantityUsd: "60",
      raw: { market: GOLD_MARKET },
    },
    {
      id: 72,
      tradeId: 7,
      exchangeId: "arcus",
      side: "long",
      status: "planned",
      quantityBase: "2",
      quantityUsd: "60",
      raw: { market: SILVER_MARKET },
    },
  ]);
}

const limitCalls = (calls: ExecutionOrderRequest[]) =>
  calls.filter((call) => call.type === "limit");
const hedgeCalls = (calls: ExecutionOrderRequest[]) =>
  calls.filter(
    (call) =>
      call.type === "market" && call.symbol === SILVER_MARKET && !call.reduceOnly,
  );

// ---------- createMetalTrade: order-book gate refusals ----------

test("gate refuses a wide/thin SLV book (drag over maxEntrySlippageBps) and persists nothing", async () => {
  const db = createFakeDrizzleDb();
  const { execution } = fakeMetalExecution({
    depth: {
      // Buying 2 SLV walks 0.5 @ 30.01 + 1.5 @ 31.00 => ~251 bps over mid.
      bids: [{ priceUsd: "29.99", sizeBase: "5" }],
      asks: [
        { priceUsd: "30.01", sizeBase: "0.5" },
        { priceUsd: "31", sizeBase: "5" },
      ],
      receivedAt: new Date(),
    },
  });
  const { ctx } = makeContext(db, execution);
  await assert.rejects(
    () => createMetalTrade(ctx, "short_gold_long_silver"),
    /order-book gate: estimated entry drag .* exceeds GOLDSILVER_MAX_ENTRY_SLIPPAGE_BPS=40/,
  );
  assert.equal(db.rows(trades).length, 0);
  assert.equal(db.rows(tradeLegs).length, 0);
  assert.equal(db.unparsedConditions.length, 0);
});

test("gate refuses when the adapter does not expose getOrderBookDepth", async () => {
  const db = createFakeDrizzleDb();
  const { execution } = fakeMetalExecution({ noDepth: true });
  const { ctx } = makeContext(db, execution);
  await assert.rejects(
    () => createMetalTrade(ctx, "short_gold_long_silver"),
    /does not expose getOrderBookDepth/,
  );
  assert.equal(db.rows(trades).length, 0);
  assert.equal(db.rows(tradeLegs).length, 0);
});

test("gate refuses when the hedge side of the SLV book has no levels", async () => {
  const db = createFakeDrizzleDb();
  // short_gold_long_silver => the hedge BUYS silver => walks the asks.
  const { execution } = fakeMetalExecution({
    depth: {
      bids: [{ priceUsd: "29.99", sizeBase: "5" }],
      asks: [],
      receivedAt: new Date(),
    },
  });
  const { ctx } = makeContext(db, execution);
  await assert.rejects(
    () => createMetalTrade(ctx, "short_gold_long_silver"),
    /no liquidity on the hedge side \(asks\)/,
  );
  assert.equal(db.rows(trades).length, 0);
  assert.equal(db.rows(tradeLegs).length, 0);
});

test("gate refuses when the SLV book cannot fill the hedge quantity", async () => {
  const db = createFakeDrizzleDb();
  const { execution } = fakeMetalExecution({
    depth: {
      bids: [{ priceUsd: "29.99", sizeBase: "5" }],
      asks: [{ priceUsd: "30.01", sizeBase: "1" }], // only 1 of the 2 SLV
      receivedAt: new Date(),
    },
  });
  const { ctx } = makeContext(db, execution);
  await assert.rejects(
    () => createMetalTrade(ctx, "short_gold_long_silver"),
    /order book is too thin/,
  );
  assert.equal(db.rows(trades).length, 0);
  assert.equal(db.rows(tradeLegs).length, 0);
});

test("gate refuses after the depth read fails twice (bounded retry)", async () => {
  const db = createFakeDrizzleDb();
  const { execution, depthCallCount } = fakeMetalExecution({
    depthFailures: Number.POSITIVE_INFINITY,
  });
  const { ctx } = makeContext(db, execution);
  await assert.rejects(
    () => createMetalTrade(ctx, "short_gold_long_silver"),
    /depth read failed after 2 attempts/,
  );
  assert.equal(depthCallCount(), 2);
  assert.equal(db.rows(trades).length, 0);
  assert.equal(db.rows(tradeLegs).length, 0);
});

test("duplicate guard refuses while another metal trade is active (joined query)", async () => {
  const db = createFakeDrizzleDb();
  db.seed(trades, [
    {
      id: 9,
      symbol: "GOLDSILVER",
      marketType: "perpetual",
      priceSource: "mark",
      mode: "dry-run",
      status: "open",
      longExchange: "arcus",
      shortExchange: "arcus",
      leverage: 3,
      filledNotionalUsd: "60",
      openedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);
  db.seed(tradeLegs, [
    {
      id: 91,
      tradeId: 9,
      exchangeId: "arcus",
      side: "short",
      status: "open",
      quantityBase: "0.02",
      raw: { market: GOLD_MARKET },
    },
    {
      id: 92,
      tradeId: 9,
      exchangeId: "arcus",
      side: "long",
      status: "open",
      quantityBase: "2",
      raw: { market: SILVER_MARKET },
    },
  ]);
  const { execution, calls } = fakeMetalExecution();
  const { ctx } = makeContext(db, execution);
  await assert.rejects(
    () => createMetalTrade(ctx, "short_gold_long_silver"),
    /already active \(trade #9, open\)/,
  );
  // The refusal happens before any order or insert.
  assert.equal(calls.length, 0);
  assert.equal(db.rows(trades).length, 1);
  assert.equal(db.rows(tradeLegs).length, 2);
  // The projection + innerJoin + inArray condition was fully parsed.
  assert.equal(db.unparsedConditions.length, 0);
});

// ---------- createMetalTrade: happy path ----------

test("creates the trade and two planned dollar-neutral legs on arcus", async () => {
  const db = createFakeDrizzleDb();
  const { execution } = fakeMetalExecution();
  const { ctx } = makeContext(db, execution);
  const tradeId = await createMetalTrade(ctx, "short_gold_long_silver");
  assert.equal(tradeId, 1);

  const tradeRows = db.rows(trades);
  assert.equal(tradeRows.length, 1);
  assert.equal(tradeRows[0]!.symbol, "GOLDSILVER");
  assert.equal(tradeRows[0]!.status, "executing_limit");
  assert.equal(tradeRows[0]!.mode, ExecutionMode.DryRun);
  assert.equal(tradeRows[0]!.longExchange, "arcus");
  assert.equal(tradeRows[0]!.shortExchange, "arcus");
  assert.equal(tradeRows[0]!.leverage, 3);

  const legRows = db.rows(tradeLegs);
  assert.equal(legRows.length, 2);
  const gold = legRows.find((leg) => leg.raw?.market === GOLD_MARKET)!;
  const silver = legRows.find((leg) => leg.raw?.market === SILVER_MARKET)!;
  assert.ok(gold && silver);
  assert.equal(gold.tradeId, 1);
  assert.equal(silver.tradeId, 1);
  assert.equal(gold.status, "planned");
  assert.equal(silver.status, "planned");
  assert.equal(gold.exchangeId, "arcus");
  assert.equal(silver.exchangeId, "arcus");
  // short gold / long silver.
  assert.equal(gold.side, "short");
  assert.equal(silver.side, "long");
  // Dollar-neutral sizing ($60 notional per leg): the gold base quantity
  // is the smaller one.
  assert.equal(gold.quantityBase, "0.025");
  assert.equal(silver.quantityBase, "2");
  assert.ok(Number(gold.quantityBase) < Number(silver.quantityBase));
  assert.equal(db.unparsedConditions.length, 0);
});

test("a failing depth read is retried once and the entry proceeds", async () => {
  const db = createFakeDrizzleDb();
  const { execution, depthCallCount } = fakeMetalExecution({
    depthFailures: 1,
  });
  const { ctx } = makeContext(db, execution);
  const tradeId = await createMetalTrade(ctx, "long_gold_short_silver");
  assert.equal(tradeId, 1);
  assert.equal(depthCallCount(), 2);
  assert.equal(db.rows(tradeLegs).length, 2);
});

// ---------- executeMetalTradeEntry ----------

test("entry rests a post-only-legal GLD limit, hedges at market with a price bound, and opens", async () => {
  const db = createFakeDrizzleDb();
  seedExecutingEntry(db);
  const { execution, calls } = fakeMetalExecution();
  const { ctx, notifications, urgentNotifications } = makeContext(db, execution);
  await executeMetalTradeEntry(ctx, 7);

  // GLD limit: SELL improved one $1 tick from the $2399 bid => rests at
  // $2400 (a sell crosses only at price <= bid, so this never crosses).
  const limits = limitCalls(calls);
  assert.equal(limits.length, 1);
  assert.equal(limits[0]!.symbol, GOLD_MARKET);
  assert.equal(limits[0]!.side, "sell");
  assert.equal(limits[0]!.quantityBase, "0.025");
  assert.equal(limits[0]!.priceUsd, "2400");
  assert.ok(Number(limits[0]!.priceUsd) > Number(GOLD_BBO.bidUsd));

  // SLV hedge: market BUY for the full 2 SLV with the explicit bound
  // (ask 30 x (1 + 40bps) = 30.12) and NO reduceOnly on entry.
  const hedges = hedgeCalls(calls);
  assert.equal(hedges.length, 1);
  assert.equal(hedges[0]!.side, "buy");
  assert.equal(hedges[0]!.quantityBase, "2");
  assert.ok(Math.abs(Number(hedges[0]!.priceUsd) - 30.12) < 1e-9);
  assert.equal(hedges[0]!.reduceOnly, undefined);

  // Disaster stops: reduce-only stop-market on both legs (gold short =>
  // buy above entry; silver long => sell below the VWAP).
  const stops = calls.filter((call) => call.type === "stop-market");
  assert.equal(stops.length, 2);
  const goldStop = stops.find((call) => call.symbol === GOLD_MARKET)!;
  const silverStop = stops.find((call) => call.symbol === SILVER_MARKET)!;
  assert.equal(goldStop.side, "buy");
  assert.equal(goldStop.reduceOnly, true);
  assert.ok(Number(goldStop.triggerPriceUsd) > 2400);
  assert.equal(silverStop.side, "sell");
  assert.equal(silverStop.reduceOnly, true);
  assert.ok(Number(silverStop.triggerPriceUsd) < 30);

  // Persistence: both legs open with fill data, stop ids in raw, trade open.
  const gold = db.rows(tradeLegs).find((leg) => leg.id === 71)!;
  const silver = db.rows(tradeLegs).find((leg) => leg.id === 72)!;
  assert.equal(gold.status, "open");
  assert.equal(gold.entryPriceUsd, "2400");
  assert.equal(gold.quantityBase, "0.025");
  assert.ok(typeof gold.raw?.slOrderId === "string");
  assert.equal(silver.status, "open");
  assert.equal(silver.entryPriceUsd, "30");
  assert.equal(silver.quantityBase, "2");
  assert.equal(silver.entryFeeUsd, "0.05");
  assert.ok(typeof silver.raw?.slOrderId === "string");
  assert.equal(db.rows(trades)[0]!.status, "open");

  assert.ok(notifications.some((text) => text.includes("trade #7 OPEN")));
  assert.equal(urgentNotifications.length, 0);
  assert.equal(db.unparsedConditions.length, 0);
});

test("a post-only rejection re-clamps the limit and the flow continues to the hedge", async () => {
  const db = createFakeDrizzleDb();
  seedExecutingEntry(db);
  const { execution, calls } = fakeMetalExecution({
    firstLimitRejection: "POST_ONLY_WOULD_CROSS: order would immediately match",
  });
  const { ctx, urgentNotifications } = makeContext(db, execution);
  await executeMetalTradeEntry(ctx, 7);

  const limits = limitCalls(calls);
  assert.equal(limits.length, 2);
  // The retry re-reads the (unchanged) BBO and re-clamps to the same
  // post-only-legal price.
  assert.equal(limits[0]!.priceUsd, "2400");
  assert.equal(limits[1]!.priceUsd, "2400");
  assert.equal(hedgeCalls(calls).length, 1);
  assert.equal(db.rows(trades)[0]!.status, "open");
  assert.equal(urgentNotifications.length, 0);
});

test("a zero-filled hedge re-bounds from a fresh BBO and hedges the full remainder", async () => {
  const db = createFakeDrizzleDb();
  seedExecutingEntry(db);
  const { execution, calls } = fakeMetalExecution({
    hedgeFills: [
      { status: "cancelled", filledQuantityBase: "0" },
      {
        status: "filled",
        filledQuantityBase: "2",
        averageFillPriceUsd: "30.02",
        feeUsd: "0.06",
      },
    ],
  });
  const { ctx, notifications } = makeContext(db, execution);
  await executeMetalTradeEntry(ctx, 7);

  const hedges = hedgeCalls(calls);
  assert.equal(hedges.length, 2);
  // Zero fill => the retry hedges the FULL remainder, not a reduced qty.
  assert.equal(hedges[0]!.quantityBase, "2");
  assert.equal(hedges[1]!.quantityBase, "2");

  const silver = db.rows(tradeLegs).find((leg) => leg.id === 72)!;
  assert.equal(silver.entryPriceUsd, "30.02");
  assert.equal(silver.quantityBase, "2");
  assert.equal(db.rows(trades)[0]!.status, "open");
  assert.ok(notifications.some((text) => text.includes("after 2 attempts")));
});

test("partial hedge fills accumulate into the silver leg VWAP and retry only the remainder", async () => {
  const db = createFakeDrizzleDb();
  seedExecutingEntry(db);
  const { execution, calls } = fakeMetalExecution({
    hedgeFills: [
      {
        status: "cancelled",
        filledQuantityBase: "0.5",
        averageFillPriceUsd: "30",
        feeUsd: "0.01",
      },
      {
        status: "filled",
        filledQuantityBase: "1.5",
        averageFillPriceUsd: "30.1",
        feeUsd: "0.05",
      },
    ],
  });
  const { ctx } = makeContext(db, execution);
  await executeMetalTradeEntry(ctx, 7);

  const hedges = hedgeCalls(calls);
  assert.equal(hedges.length, 2);
  assert.equal(hedges[0]!.quantityBase, "2");
  assert.equal(hedges[1]!.quantityBase, "1.5");

  // VWAP = (0.5 x 30 + 1.5 x 30.1) / 2 = 30.075; fees accumulate.
  const silver = db.rows(tradeLegs).find((leg) => leg.id === 72)!;
  assert.equal(silver.entryPriceUsd, "30.075");
  assert.equal(silver.quantityBase, "2");
  assert.equal(silver.entryFeeUsd, "0.06");
  assert.equal(db.rows(trades)[0]!.status, "open");
});

test("exhausted hedge retries abort the entry and persist failed/cancelled state", async () => {
  const db = createFakeDrizzleDb();
  seedExecutingEntry(db);
  const { execution, calls, cancels } = fakeMetalExecution({
    hedgeFills: [{ status: "cancelled", filledQuantityBase: "0" }],
  });
  const { ctx, urgentNotifications } = makeContext(db, execution);
  await executeMetalTradeEntry(ctx, 7);

  // 3 bounded hedge attempts (GOLDSILVER_HEDGE_RETRY_ATTEMPTS), all zero.
  assert.equal(hedgeCalls(calls).length, 3);
  // The resting GLD limit cancel is verified before the abort completes.
  assert.equal(cancels.length, 1);
  assert.equal(cancels[0]!.market, GOLD_MARKET);

  // Terminal state: ALL legs cancelled, trade failed, urgent notice.
  assert.deepEqual(
    db.rows(tradeLegs).map((leg) => leg.status),
    ["cancelled", "cancelled"],
  );
  assert.equal(db.rows(trades)[0]!.status, "failed");
  assert.equal(urgentNotifications.length, 1);
  assert.match(urgentNotifications[0]!, /FAILED at entry/);
  assert.match(urgentNotifications[0]!, /unhedged after 3 bounded attempt/);

  // Rollback correctness (fixed leak): the GLD limit already filled 0.025
  // on the exchange, and hedgeIncrement now credits progress.goldFilledQty
  // BEFORE hedging, so abortEntry sees the covered quantity and
  // market-closes it — a reduce-only BUY of the 0.025 GLD (gold leg is
  // short). The urgent notice reports the covered close and carries no
  // UNVERIFIED CLOSES warning.
  const rollbackCloses = calls.filter(
    (call) => call.reduceOnly && call.type === "market",
  );
  assert.equal(rollbackCloses.length, 1);
  assert.equal(rollbackCloses[0]!.symbol, GOLD_MARKET);
  assert.equal(rollbackCloses[0]!.side, "buy");
  assert.equal(rollbackCloses[0]!.quantityBase, "0.025");
  assert.match(urgentNotifications[0]!, /Covered quantity was market-closed/);
  assert.match(urgentNotifications[0]!, /GLD 0\.025/);
  assert.doesNotMatch(urgentNotifications[0]!, /UNVERIFIED CLOSES/);
});

test("entry is a no-op unless the trade is still executing_limit", async () => {
  const db = createFakeDrizzleDb();
  seedExecutingEntry(db, "open");
  const { execution, calls } = fakeMetalExecution();
  const { ctx, notifications } = makeContext(db, execution);
  await executeMetalTradeEntry(ctx, 7);
  assert.equal(calls.length, 0);
  assert.equal(notifications.length, 0);
  // Unchanged legs.
  assert.deepEqual(
    db.rows(tradeLegs).map((leg) => leg.status),
    ["planned", "planned"],
  );

  // A missing trade row is a no-op too.
  const emptyDb = createFakeDrizzleDb();
  const second = fakeMetalExecution();
  const { ctx: emptyCtx } = makeContext(emptyDb, second.execution);
  await executeMetalTradeEntry(emptyCtx, 999);
  assert.equal(second.calls.length, 0);
});
