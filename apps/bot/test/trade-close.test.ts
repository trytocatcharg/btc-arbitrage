import assert from "node:assert/strict";
import test from "node:test";
import {
  closeTradeBothLegs,
  formatPnlColored,
  type CloseLegInput,
} from "../src/trading/trade-close.js";
import type {
  OpenTradeState,
  PreviewStore,
  TransitionDetails,
} from "../src/trading/open-trade.js";
import type {
  ExchangeAdapter,
  ExchangePosition,
} from "@btc-arbitrage/exchange-core";

test("cancels both TP/SL backstops from leg raw and ignores cancel failures", async () => {
  const risex = fakeAdapter("risex");
  const extended = fakeAdapter("extended", { cancelThrowsFor: ["tp-ext"] });
  const store = memoryStore();
  await closeTradeBothLegs(
    closeInput(store, registry(risex, extended), [longLeg(), shortLeg()]),
  );
  assert.deepEqual(risex.cancels, ["tp-risex", "sl-risex"]);
  assert.deepEqual(extended.cancels, ["tp-ext", "sl-ext"]);
  // The failed extended TP cancel is non-fatal: the close still ran and the
  // trade reached "closed".
  assert.deepEqual(
    store.transitions.map((t) => t.state),
    ["closing", "closed"],
  );
});

test("submits reduce-only market closes with opposite side and token-reason clientOrderId", async () => {
  const risex = fakeAdapter("risex");
  const extended = fakeAdapter("extended");
  const store = memoryStore();
  await closeTradeBothLegs(
    closeInput(store, registry(risex, extended), [longLeg(), shortLeg()]),
  );
  assert.equal(risex.calls.length, 1);
  assert.deepEqual(risex.calls[0], {
    clientOrderId: "test-token-123-manual_close-risex",
    symbol: "BTCUSDT",
    side: "sell",
    type: "market",
    quantityBase: "0.01",
    reduceOnly: true,
  });
  assert.equal(extended.calls.length, 1);
  assert.deepEqual(extended.calls[0], {
    clientOrderId: "test-token-123-manual_close-extended",
    symbol: "BTCUSDT",
    side: "buy",
    type: "market",
    quantityBase: "0.01",
    reduceOnly: true,
  });
});

test("happy path persists closed legs with ack exit price and GROSS realized PnL", async () => {
  const risex = fakeAdapter("risex", { closeFillPriceUsd: "100200" });
  const extended = fakeAdapter("extended", { closeFillPriceUsd: "100100" });
  const store = memoryStore();
  const notices: string[] = [];
  const result = await closeTradeBothLegs({
    ...closeInput(store, registry(risex, extended), [longLeg(), shortLeg()]),
    notify: async (text) => {
      notices.push(text);
    },
  });
  // Long: (100200 - 100000) * 0.01 = +2; short: (100100 - 100300) * 0.01 * -1 = +2.
  // formatDecimal strips trailing zeros, so 4.00000000 is "4".
  assert.equal(result.realizedPnlUsd, "4");
  assert.deepEqual(
    store.transitions.map((t) => t.state),
    ["closing", "closed"],
  );
  const final = store.transitions.at(-1)!.details!;
  assert.equal(final.closeReason, "manual_close");
  assert.equal(final.realizedPnlUsd, "4");
  const risexLeg = final.legs!.find((leg) => leg.exchangeId === "risex")!;
  assert.equal(risexLeg.status, "closed");
  assert.equal(risexLeg.closeReason, "manual_close");
  assert.equal(risexLeg.exitPriceUsd, "100200");
  assert.equal(risexLeg.entryPriceUsd, "100000");
  const extendedLeg = final.legs!.find(
    (leg) => leg.exchangeId === "extended",
  )!;
  assert.equal(extendedLeg.status, "closed");
  assert.equal(extendedLeg.exitPriceUsd, "100100");
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /📕 Trade #42 closed \(manual_close\)/);
  assert.match(notices[0]!, /Realized PnL: \+\$4\.00/);
});

test("leg still open past the flat deadline persists unhedged with close_failed and trade unhedged", async () => {
  const openPosition: ExchangePosition = {
    side: "long",
    quantityBase: "0.01",
    status: "open",
  };
  let risexPolls = 0;
  const risex = fakeAdapter("risex", {
    closeFillPriceUsd: "100200",
    position: () => {
      risexPolls += 1;
      return openPosition;
    },
  });
  const extended = fakeAdapter("extended", { closeFillPriceUsd: "100100" });
  const store = memoryStore();
  const clock = fakeClock();
  const result = await closeTradeBothLegs({
    ...closeInput(store, registry(risex, extended), [longLeg(), shortLeg()]),
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.ok(risexPolls > 1, "the flat wait must poll until the deadline");
  assert.deepEqual(
    store.transitions.map((t) => t.state),
    ["closing", "unhedged"],
  );
  const final = store.transitions.at(-1)!.details!;
  const risexLeg = final.legs!.find((leg) => leg.exchangeId === "risex")!;
  assert.equal(risexLeg.status, "unhedged");
  assert.equal(risexLeg.closeReason, "close_failed");
  const extendedLeg = final.legs!.find(
    (leg) => leg.exchangeId === "extended",
  )!;
  assert.equal(extendedLeg.status, "closed");
  assert.equal(extendedLeg.closeReason, "manual_close");
  // The unhedged leg's ack exit price still feeds the gross PnL total.
  assert.equal(result.realizedPnlUsd, "4");
});

test("derived gross PnL wins over exchange-reported realized PnL; exchange value is fallback only", async () => {
  // Long leg: closed position reports a NET realized PnL (1.95, exit fee
  // subtracted by the exchange) AND an exit price — the derived gross
  // ((100200 - 100000) * 0.01 = 2.00) must win for the trade total so the
  // exit fee is never double-subtracted (trade #637 convention).
  const risex = fakeAdapter("risex", {
    position: () => ({
      side: "long",
      quantityBase: "0.01",
      status: "closed",
      exitPriceUsd: "100200",
      realizedPnlUsd: "1.95",
    }),
  });
  // Short leg: no exit price anywhere (position closed without one, ack
  // carries none) — only then does the exchange-reported realized PnL act
  // as the fallback for the trade total.
  const extended = fakeAdapter("extended", {
    closeFillPriceUsd: undefined,
    position: () => ({
      side: "short",
      quantityBase: "0.01",
      status: "closed",
      realizedPnlUsd: "1.5",
    }),
  });
  const store = memoryStore();
  const result = await closeTradeBothLegs(
    closeInput(store, registry(risex, extended), [longLeg(), shortLeg()]),
  );
  assert.equal(result.realizedPnlUsd, "3.5");
  const final = store.transitions.at(-1)!.details!;
  assert.equal(final.realizedPnlUsd, "3.5");
  // Per-leg realizedPnlUsd is stored as reported by the exchange (as-is);
  // only the trade total applies the always-GROSS derivation.
  const risexLeg = final.legs!.find((leg) => leg.exchangeId === "risex")!;
  assert.equal(risexLeg.realizedPnlUsd, "1.95");
  assert.equal(risexLeg.exitPriceUsd, "100200");
  const extendedLeg = final.legs!.find(
    (leg) => leg.exchangeId === "extended",
  )!;
  assert.equal(extendedLeg.realizedPnlUsd, "1.5");
  assert.equal(extendedLeg.exitPriceUsd, undefined);
});

test("final persist failure notifies urgently and the pre-persisted closing state stands", async () => {
  const risex = fakeAdapter("risex", { closeFillPriceUsd: "100200" });
  const extended = fakeAdapter("extended", { closeFillPriceUsd: "100100" });
  const store = memoryStore({ failOnTransitionCall: 2 });
  const notices: string[] = [];
  const result = await closeTradeBothLegs({
    ...closeInput(store, registry(risex, extended), [longLeg(), shortLeg()]),
    notify: async (text) => {
      notices.push(text);
    },
  });
  // The "closing" pre-persist (first transition) succeeded; the final
  // "closed" persist (second transition) threw.
  assert.deepEqual(
    store.transitions.map((t) => t.state),
    ["closing"],
  );
  assert.equal(notices.length, 2);
  assert.match(notices[0]!, /🚨 Trade #42 closed on the exchange/);
  assert.match(notices[0]!, /DB persist failed/);
  assert.match(notices[0]!, /recovery sweep/i);
  assert.match(notices[1]!, /📕 Trade #42 closed \(manual_close\)/);
  // The exchange-side outcome is still reported to the caller.
  assert.equal(result.realizedPnlUsd, "4");
});

test("formatPnlColored formats sign and null", () => {
  assert.equal(formatPnlColored(1.5), "🟢 +$1.50");
  assert.equal(formatPnlColored(0), "🟢 +$0.00");
  assert.equal(formatPnlColored(-2.25), "🔴 -$2.25");
  assert.equal(formatPnlColored(null), "n/a (exit price unavailable)");
});

function longLeg(): CloseLegInput {
  return {
    exchangeId: "risex",
    side: "long",
    quantityBase: "0.01",
    entryPriceUsd: "100000",
    raw: { tpOrderId: "tp-risex", slOrderId: "sl-risex" },
  };
}
function shortLeg(): CloseLegInput {
  return {
    exchangeId: "extended",
    side: "short",
    quantityBase: "0.01",
    entryPriceUsd: "100300",
    raw: { tpOrderId: "tp-ext", slOrderId: "sl-ext" },
  };
}
function closeInput(
  store: PreviewStore,
  reg: { get(id: string): ExchangeAdapter },
  legs: CloseLegInput[],
) {
  const clock = fakeClock();
  return {
    store,
    registry: reg,
    token: "test-token-123",
    label: "#42",
    symbol: "BTCUSDT",
    longExchange: "risex",
    shortExchange: "extended",
    legs,
    reason: "manual_close" as const,
    notify: async () => undefined,
    now: clock.now,
    sleep: clock.sleep,
  };
}
function fakeClock(stepMs = 6000) {
  let t = 0;
  return {
    now: () => new Date((t += stepMs)),
    sleep: async () => undefined,
  };
}
function registry(...adapters: ExchangeAdapter[]) {
  return {
    get: (id: string) => {
      const adapter = adapters.find((x) => x.id === id);
      if (!adapter) throw new Error("missing");
      return adapter;
    },
  };
}
function fakeAdapter(
  id: "risex" | "extended",
  options: {
    /** Fill price reported on the close market-order ack. */
    closeFillPriceUsd?: string;
    /** Position returned by getPosition; defaults to null (flat). */
    position?: () => ExchangePosition | null;
    /** Order ids whose cancel rejects (a triggered backstop). */
    cancelThrowsFor?: string[];
  } = {},
) {
  const calls: any[] = [];
  const cancels: string[] = [];
  const adapter: ExchangeAdapter & { calls: any[]; cancels: string[] } = {
    id,
    displayName: id,
    capabilities: {
      nativeFetch: true,
      websocket: "polling-only",
      orderPlacement: true,
    },
    getMarkets: async () => [],
    getPriceSnapshot: async () => ({}) as any,
    calls,
    cancels,
    execution: {
      getBestBidOffer: async () => ({
        bidUsd: "99999",
        askUsd: "100001",
        receivedAt: new Date(),
      }),
      getMarketMetadata: async () => ({
        minQuantityBase: "0.001",
        quantityStepBase: "0.001",
      }),
      getAvailableMarginUsd: async () => "99999",
      validateExecutionPreflight: async () => undefined,
      submitExecutionOrder: async (input) => {
        calls.push(input);
        return {
          id: `close-${id}-${calls.length}`,
          status: "filled" as const,
          filledQuantityBase: input.quantityBase,
          averageFillPriceUsd: options.closeFillPriceUsd,
        };
      },
      getExecutionOrder: async () => {
        throw new Error("not used by closeTradeBothLegs");
      },
      cancelExecutionOrder: async (orderId) => {
        cancels.push(orderId);
        if (options.cancelThrowsFor?.includes(orderId))
          throw new Error("order already triggered");
      },
      getPosition: async () => options.position?.() ?? null,
    },
  };
  return adapter;
}
function memoryStore(options: { failOnTransitionCall?: number } = {}): PreviewStore & {
  transitions: Array<{ state: OpenTradeState; details?: TransitionDetails }>;
} {
  const transitions: Array<{ state: OpenTradeState; details?: TransitionDetails }> =
    [];
  let transitionCalls = 0;
  return {
    transitions,
    async createPreview() {
      /* no-op */
    },
    async consumePreview() {
      return null;
    },
    async startExecution() {
      /* no-op */
    },
    async claimRollback() {
      return true;
    },
    async reactivateExecution() {
      /* no-op */
    },
    async transition(_token, state, details) {
      transitionCalls += 1;
      if (options.failOnTransitionCall === transitionCalls)
        throw new Error("db down");
      transitions.push({ state, details });
    },
    async hasBlockingExecution() {
      return false;
    },
  };
}
