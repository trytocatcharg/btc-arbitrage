import assert from "node:assert/strict";
import test from "node:test";
import type { BotConfig } from "@btc-arbitrage/config";
import {
  applyEtfTimeStopHours,
  applyMetalTimeStopHours,
  isRuntimeSettingOverridden,
  snapshotRuntimeSettings,
} from "../src/runtime/runtime-settings.js";
import { formatActiveConfigSummary } from "../src/notifications/telegram-command-poller.js";

/** Minimal BotConfig fixture: only the fields read by the runtime-settings
 * appliers/baseline and formatActiveConfigSummary. Hand-built object cast
 * to BotConfig, same pattern as metal-trade-entry.test.ts. */
function botConfig(): BotConfig {
  return {
    instanceId: "main",
    strategy: "both",
    botExecutionMode: "dry-run",
    btcSymbol: "BTCUSDT",
    marketType: "perpetual",
    priceSource: "mark",
    pricePollIntervalMs: 1000,
    minPriceDiffUsd: "40.00",
    leverage: 3,
    exchangeA: "risex",
    exchangeB: "extended",
    risex: { apiBaseUrl: "https://risex.invalid", tradingEnabled: false },
    extended: { apiBaseUrl: "https://extended.invalid", tradingEnabled: false },
    telegram: {
      alertCooldownMs: 3_600_000,
    },
    openTrade: {
      marginUsd: "20.00",
      notionalUsd: "60.00000000",
      autoConfirm: false,
      takeProfitPercent: 3,
      stopLossPercent: 2.5,
    },
    goldSilver: {
      marginUsd: "20.00",
      leverage: 3,
      rsiPeriod: 14,
      rsiConfirmBand: 5,
      candleTimeframe: "1h",
      tpMinNetUsd: "10.00",
      maxEntrySlippageBps: 40,
      hedgeRetryAttempts: 3,
      stopLossMarginPercent: 50,
      timeStopHours: 48,
    },
    spyQqq: {
      marginUsd: "20.00",
      leverage: 3,
      rsiPeriod: 14,
      rsiConfirmBand: 5,
      candleTimeframe: "1h",
      tpMinNetUsd: "10.00",
      maxEntrySlippageBps: 40,
      hedgeRetryAttempts: 3,
      stopLossMarginPercent: 50,
      timeStopHours: 48,
    },
  } as unknown as BotConfig;
}

test("applyMetalTimeStopHours mutates goldSilver only and reports the change", () => {
  const config = botConfig();
  const change = applyMetalTimeStopHours(config, 72);
  assert.equal(config.goldSilver.timeStopHours, 72);
  assert.equal(config.spyQqq.timeStopHours, 48, "etf section untouched");
  assert.equal(change.key, "metalTimeStopHours");
  assert.equal(
    change.summary,
    "Metal time-stop: 72h (market close at age ≥ threshold)",
  );
});

test("applyEtfTimeStopHours mutates spyQqq only and reports the change", () => {
  const config = botConfig();
  const change = applyEtfTimeStopHours(config, 96);
  assert.equal(config.spyQqq.timeStopHours, 96);
  assert.equal(config.goldSilver.timeStopHours, 48, "metal section untouched");
  assert.equal(change.key, "etfTimeStopHours");
  assert.equal(
    change.summary,
    "ETF time-stop: 96h (market close at age ≥ threshold)",
  );
});

test("time-stop appliers accept the preset values and the 1..720 bounds", () => {
  const config = botConfig();
  for (const hours of [48, 72, 96, 1, 720]) {
    assert.equal(applyMetalTimeStopHours(config, hours).key, "metalTimeStopHours");
    assert.equal(config.goldSilver.timeStopHours, hours);
    assert.equal(applyEtfTimeStopHours(config, hours).key, "etfTimeStopHours");
    assert.equal(config.spyQqq.timeStopHours, hours);
  }
});

test("time-stop appliers reject 0, negative, non-integer, >720 and NaN", () => {
  const config = botConfig();
  for (const hours of [0, -5, 2.5, 721, Number.NaN]) {
    assert.throws(
      () => applyMetalTimeStopHours(config, hours),
      /Metal time-stop must be an integer between 1 and 720 hours\./,
    );
    assert.throws(
      () => applyEtfTimeStopHours(config, hours),
      /ETF time-stop must be an integer between 1 and 720 hours\./,
    );
  }
  // Rejected values never mutate the config.
  assert.equal(config.goldSilver.timeStopHours, 48);
  assert.equal(config.spyQqq.timeStopHours, 48);
});

test("isRuntimeSettingOverridden is false on a fresh snapshot for both keys", () => {
  const config = botConfig();
  const baseline = snapshotRuntimeSettings(config);
  assert.equal(baseline.metalTimeStopHours, 48);
  assert.equal(baseline.etfTimeStopHours, 48);
  assert.equal(
    isRuntimeSettingOverridden("metalTimeStopHours", baseline, config),
    false,
  );
  assert.equal(
    isRuntimeSettingOverridden("etfTimeStopHours", baseline, config),
    false,
  );
});

test("isRuntimeSettingOverridden flips only for the applied strategy", () => {
  const config = botConfig();
  const baseline = snapshotRuntimeSettings(config);
  applyMetalTimeStopHours(config, 72);
  assert.equal(
    isRuntimeSettingOverridden("metalTimeStopHours", baseline, config),
    true,
  );
  assert.equal(
    isRuntimeSettingOverridden("etfTimeStopHours", baseline, config),
    false,
  );
});

test("formatActiveConfigSummary shows no time-stop marker at baseline", () => {
  const config = botConfig();
  const baseline = snapshotRuntimeSettings(config);
  const summary = formatActiveConfigSummary(config, baseline);
  assert.ok(
    summary.includes("Time-stop: 48h\n"),
    "metal time-stop line carries no * marker",
  );
  assert.ok(
    !summary.includes("adjusted at runtime"),
    "footer hidden when nothing is overridden",
  );
});

test("formatActiveConfigSummary marks the overridden metal time-stop", () => {
  const config = botConfig();
  const baseline = snapshotRuntimeSettings(config);
  applyMetalTimeStopHours(config, 72);
  const summary = formatActiveConfigSummary(config, baseline);
  assert.ok(summary.includes("Time-stop: 72h *"));
  assert.ok(
    summary.includes("Time-stop: 48h\n"),
    "etf time-stop line stays unmarked",
  );
  assert.ok(summary.includes("(* adjusted at runtime"));
});

test("formatActiveConfigSummary marks the overridden etf time-stop", () => {
  const config = botConfig();
  const baseline = snapshotRuntimeSettings(config);
  applyEtfTimeStopHours(config, 96);
  const summary = formatActiveConfigSummary(config, baseline);
  assert.ok(summary.includes("Time-stop: 96h *"));
  assert.ok(
    summary.includes("Time-stop: 48h\n"),
    "metal time-stop line stays unmarked",
  );
  assert.ok(summary.includes("(* adjusted at runtime"));
});
