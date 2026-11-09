import assert from "node:assert/strict";
import test from "node:test";
import type { BotConfig } from "@btc-arbitrage/config";
import {
  ARCUS_PAIR_SYMBOLS,
  GOLD_SILVER_SYMBOL,
  SPYQQQ_SYMBOL,
  isArcusPairSymbol,
} from "@btc-arbitrage/domain";
import {
  ARCUS_PAIR_STRATEGIES,
  getArcusPairStrategy,
  requireArcusPairStrategy,
  resolveArcusPairConfig,
} from "../src/metal-ratio/arcus-pair-strategies.js";

test("registry holds the GOLDSILVER and SPYQQQ specs with the Arcus markets", () => {
  const metals = ARCUS_PAIR_STRATEGIES[GOLD_SILVER_SYMBOL];
  assert.equal(metals.entryMarket, "GLD-USD");
  assert.equal(metals.hedgeMarket, "SLV-USD");
  assert.deepEqual(metals.yahooSymbols, ["GC=F", "SI=F"]);
  assert.equal(metals.envPrefix, "GOLDSILVER");
  assert.equal(metals.entryAsset, "GLD");
  assert.equal(metals.hedgeAsset, "SLV");

  const etfs = ARCUS_PAIR_STRATEGIES[SPYQQQ_SYMBOL];
  assert.equal(etfs.entryMarket, "SPY-USD");
  assert.equal(etfs.hedgeMarket, "QQQ-USD");
  assert.deepEqual(etfs.yahooSymbols, ["SPY", "QQQ"]);
  assert.equal(etfs.envPrefix, "SPYQQQ");
  assert.equal(etfs.entryAsset, "SPY");
  assert.equal(etfs.hedgeAsset, "QQQ");

  assert.deepEqual(
    [...ARCUS_PAIR_SYMBOLS].sort(),
    [GOLD_SILVER_SYMBOL, SPYQQQ_SYMBOL].sort(),
  );
});

test("isArcusPairSymbol / getArcusPairStrategy scope the pair set", () => {
  assert.equal(isArcusPairSymbol("GOLDSILVER"), true);
  assert.equal(isArcusPairSymbol("SPYQQQ"), true);
  assert.equal(isArcusPairSymbol("BTCUSDT"), false);
  assert.equal(getArcusPairStrategy("BTCUSDT"), undefined);
  assert.throws(
    () => requireArcusPairStrategy("BTCUSDT"),
    /Unknown Arcus-pair strategy symbol/,
  );
  assert.equal(
    requireArcusPairStrategy("SPYQQQ").hedgeMarket,
    "QQQ-USD",
  );
});

test("resolveArcusPairConfig maps each strategy symbol to its own config section", () => {
  const config = {
    goldSilver: { marker: "gold" },
    spyQqq: { marker: "etf" },
  } as unknown as BotConfig;
  assert.equal(
    (resolveArcusPairConfig(config, "GOLDSILVER") as { marker: string })
      .marker,
    "gold",
  );
  assert.equal(
    (resolveArcusPairConfig(config, "SPYQQQ") as { marker: string }).marker,
    "etf",
  );
});
