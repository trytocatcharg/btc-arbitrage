import { isSupportedTradingSymbol } from "@btc-arbitrage/domain";
import type { BotConfig } from "@btc-arbitrage/config";

// Runtime-adjustable bot settings. These appliers mutate the live BotConfig
// in place; main.ts shares one config object reference across the notifier,
// the command poller and the polling loop, so the override propagates
// everywhere without a restart. Overrides are in-memory only and are lost on
// bot restart.

export type RuntimeSettingKey =
  | "cooldownMinutes"
  | "minSpreadUsd"
  | "marginUsd"
  | "autoConfirm"
  | "tradingPair";

export interface RuntimeSettingChange {
  key: RuntimeSettingKey;
  /** Operator-facing confirmation line, e.g. "Telegram cooldown: 30 min (1800000 ms)" */
  summary: string;
}

export interface RuntimeSettingsBaseline {
  cooldownMinutes: number;
  minSpreadUsd: string;
  marginUsd: string;
  autoConfirm: boolean;
  tradingPair: string;
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
    autoConfirm: config.openTrade.autoConfirm,
    tradingPair: config.btcSymbol,
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

export function applyAutoConfirm(
  config: BotConfig,
  enabled: boolean,
): RuntimeSettingChange {
  config.openTrade.autoConfirm = enabled;
  // Mirrors the loud startup warning in main.ts: turning this on makes the
  // bot an auto-trader, so the toggle must be visible in the logs.
  if (enabled) {
    console.warn(
      "AUTO-TRADING ENABLED AT RUNTIME: the bot will open trades without " +
        "Telegram confirmation. Entry guards still apply.",
    );
  }
  return {
    key: "autoConfirm",
    summary: `Auto-confirm (auto-trading): ${enabled ? "ACTIVADO" : "desactivado"}`,
  };
}

/** Switch the strategy pair at runtime. Every downstream consumer reads
 * `config.btcSymbol` per use (polling loop, signal engine, open-trade
 * previews, execution), so mutating it in place propagates without a
 * restart. The symbol must come from the shared TRADING_PAIRS catalog —
 * the venue side resolves it by base-asset matching, so no per-exchange
 * mapping is needed. Caller is responsible for the active-trade guard and
 * the per-symbol execution preflight (see the Telegram Pairs panel). */
export function applyTradingPair(
  config: BotConfig,
  symbol: string,
): RuntimeSettingChange {
  const normalized = symbol.trim().toUpperCase();
  if (!isSupportedTradingSymbol(normalized)) {
    throw new Error(
      `Par no soportado: ${symbol}. Pares disponibles: BTC/USD, ETH/USD, NVDA/USD.`,
    );
  }
  config.btcSymbol = normalized;
  return {
    key: "tradingPair",
    summary: `Trading pair: ${normalized}`,
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
    case "autoConfirm":
      return config.openTrade.autoConfirm !== baseline.autoConfirm;
    case "tradingPair":
      return config.btcSymbol !== baseline.tradingPair;
  }
}
