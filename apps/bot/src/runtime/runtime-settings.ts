import type { BotConfig } from "@btc-arbitrage/config";

// Runtime-adjustable bot settings. These appliers mutate the live BotConfig
// in place; main.ts shares one config object reference across the notifier,
// the command poller and the polling loop, so the override propagates
// everywhere without a restart. Overrides are in-memory only and are lost on
// bot restart.

export type RuntimeSettingKey = "cooldownMinutes" | "minSpreadUsd" | "marginUsd";

export interface RuntimeSettingChange {
  key: RuntimeSettingKey;
  /** Operator-facing confirmation line, e.g. "Telegram cooldown: 30 min (1800000 ms)" */
  summary: string;
}

export interface RuntimeSettingsBaseline {
  cooldownMinutes: number;
  minSpreadUsd: string;
  marginUsd: string;
}

const MAX_COOLDOWN_MINUTES = 10_080; // 7 days
const MAX_USD_VALUE = 10_000;

export function snapshotRuntimeSettings(
  config: BotConfig,
): RuntimeSettingsBaseline {
  return {
    cooldownMinutes: config.telegram.alertCooldownMs / 60_000,
    minSpreadUsd: config.minPriceDiffUsd,
    marginUsd: config.openTrade.marginUsd,
  };
}

export function applyCooldownMinutes(
  config: BotConfig,
  minutes: number,
): RuntimeSettingChange {
  if (
    !Number.isFinite(minutes) ||
    minutes <= 0 ||
    minutes > MAX_COOLDOWN_MINUTES
  ) {
    throw new Error("El cooldown debe estar entre 1 y 10080 minutos.");
  }
  const cooldownMs = Math.round(minutes * 60_000);
  config.telegram.alertCooldownMs = cooldownMs;
  return {
    key: "cooldownMinutes",
    summary: `Telegram cooldown: ${minutes} min (${cooldownMs} ms)`,
  };
}

export function applyMinSpreadUsd(
  config: BotConfig,
  valueUsd: number,
): RuntimeSettingChange {
  if (!Number.isFinite(valueUsd) || valueUsd <= 0 || valueUsd > MAX_USD_VALUE) {
    throw new Error("El min spread debe estar entre 0 y 10000 USD.");
  }
  config.minPriceDiffUsd = valueUsd.toFixed(2);
  return {
    key: "minSpreadUsd",
    summary: `Min spread: $${valueUsd.toFixed(2)}`,
  };
}

export function applyMarginUsd(
  config: BotConfig,
  valueUsd: number,
): RuntimeSettingChange {
  if (!Number.isFinite(valueUsd) || valueUsd <= 0 || valueUsd > MAX_USD_VALUE) {
    throw new Error("El margin debe estar entre 0 y 10000 USD.");
  }
  config.openTrade.marginUsd = valueUsd.toFixed(2);
  // notionalUsd is derived at config load as margin × leverage, so a runtime
  // margin override must recompute it to keep previews consistent.
  config.openTrade.notionalUsd = (valueUsd * config.leverage).toFixed(8);
  return {
    key: "marginUsd",
    summary:
      `Open trade margin: $${valueUsd.toFixed(2)} por pata ` +
      `(notional $${(valueUsd * config.leverage).toFixed(2)} a ${config.leverage}x)`,
  };
}

export function isRuntimeSettingOverridden(
  key: RuntimeSettingKey,
  baseline: RuntimeSettingsBaseline,
  config: BotConfig,
): boolean {
  switch (key) {
    case "cooldownMinutes":
      return (
        config.telegram.alertCooldownMs !==
        Math.round(baseline.cooldownMinutes * 60_000)
      );
    case "minSpreadUsd":
      return config.minPriceDiffUsd !== baseline.minSpreadUsd;
    case "marginUsd":
      return config.openTrade.marginUsd !== baseline.marginUsd;
  }
}
