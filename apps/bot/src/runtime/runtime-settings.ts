import {
  isSupportedTradingSymbol,
  TRADING_PAIRS,
} from "@btc-arbitrage/domain";
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
  | "leverage"
  | "autoConfirm"
  | "tradingPair"
  | "metalMarginUsd"
  | "metalLeverage"
  | "metalTpMinNetUsd"
  | "metalMaxEntrySlippageBps"
  | "metalHedgeRetries"
  | "etfMarginUsd"
  | "etfLeverage"
  | "etfTpMinNetUsd"
  | "etfMaxEntrySlippageBps"
  | "etfHedgeRetries";

export interface RuntimeSettingChange {
  key: RuntimeSettingKey;
  /** Operator-facing confirmation line, e.g. "Telegram cooldown: 30 min (1800000 ms)" */
  summary: string;
}

export interface RuntimeSettingsBaseline {
  cooldownMinutes: number;
  minSpreadUsd: string;
  marginUsd: string;
  leverage: number;
  autoConfirm: boolean;
  tradingPair: string;
  metalMarginUsd: string;
  metalLeverage: number;
  metalTpMinNetUsd: string;
  metalMaxEntrySlippageBps: number;
  metalHedgeRetries: number;
  etfMarginUsd: string;
  etfLeverage: number;
  etfTpMinNetUsd: string;
  etfMaxEntrySlippageBps: number;
  etfHedgeRetries: number;
}

const MAX_COOLDOWN_MINUTES = 10_080; // 7 days
const MAX_USD_VALUE = 10_000;
export const MAX_LEVERAGE = 50;

export function snapshotRuntimeSettings(
  config: BotConfig,
): RuntimeSettingsBaseline {
  return {
    cooldownMinutes: config.telegram.alertCooldownMs / 60_000,
    minSpreadUsd: config.minPriceDiffUsd,
    marginUsd: config.openTrade.marginUsd,
    leverage: config.leverage,
    autoConfirm: config.openTrade.autoConfirm,
    tradingPair: config.btcSymbol,
    metalMarginUsd: config.goldSilver.marginUsd,
    metalLeverage: config.goldSilver.leverage,
    metalTpMinNetUsd: config.goldSilver.tpMinNetUsd,
    metalMaxEntrySlippageBps: config.goldSilver.maxEntrySlippageBps,
    metalHedgeRetries: config.goldSilver.hedgeRetryAttempts,
    etfMarginUsd: config.spyQqq.marginUsd,
    etfLeverage: config.spyQqq.leverage,
    etfTpMinNetUsd: config.spyQqq.tpMinNetUsd,
    etfMaxEntrySlippageBps: config.spyQqq.maxEntrySlippageBps,
    etfHedgeRetries: config.spyQqq.hedgeRetryAttempts,
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
    throw new Error("Cooldown must be between 1 and 10080 minutes.");
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
    throw new Error("Min spread must be between 0 and 10000 USD.");
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
    throw new Error("Margin must be between 0 and 10000 USD.");
  }
  config.openTrade.marginUsd = valueUsd.toFixed(2);
  // notionalUsd is derived at config load as margin × leverage, so a runtime
  // margin override must recompute it to keep previews consistent.
  config.openTrade.notionalUsd = (valueUsd * config.leverage).toFixed(8);
  return {
    key: "marginUsd",
    summary:
      `Open trade margin: $${valueUsd.toFixed(2)} per leg ` +
      `(notional $${(valueUsd * config.leverage).toFixed(2)} at ${config.leverage}x)`,
  };
}

export function applyLeverage(
  config: BotConfig,
  leverage: number,
): RuntimeSettingChange {
  if (
    !Number.isInteger(leverage) ||
    leverage < 1 ||
    leverage > MAX_LEVERAGE
  ) {
    throw new Error(`Leverage must be an integer between 1 and ${MAX_LEVERAGE}.`);
  }
  config.leverage = leverage;
  // Same invariant as applyMarginUsd: notionalUsd derives as margin ×
  // leverage at config load, so a runtime leverage override must
  // recompute it to keep previews consistent.
  const marginUsd = Number(config.openTrade.marginUsd);
  config.openTrade.notionalUsd = (marginUsd * leverage).toFixed(8);
  return {
    key: "leverage",
    summary:
      `Leverage: ${leverage}x ` +
      `(notional $${(marginUsd * leverage).toFixed(2)} per leg ` +
      `with margin $${marginUsd.toFixed(2)})`,
  };
}

/** Shared appliers for the Arcus-pair strategy sections (goldSilver /
 * spyQqq). The thin exported wrappers below pin each operator-facing
 * label ("Metal" / "ETF") and the persistence key, so the metals
 * summaries stay byte-identical. */
type ArcusPairSection = "goldSilver" | "spyQqq";

function applyPairMarginUsd(
  config: BotConfig,
  section: ArcusPairSection,
  key: RuntimeSettingKey,
  label: string,
  valueUsd: number,
): RuntimeSettingChange {
  if (!Number.isFinite(valueUsd) || valueUsd <= 0 || valueUsd > MAX_USD_VALUE) {
    throw new Error("Margin must be between 0 and 10000 USD.");
  }
  const cfg = config[section];
  cfg.marginUsd = valueUsd.toFixed(2);
  // Unlike the BTC openTrade section, the pair trade derives its notional
  // at ENTRY time (createMetalTrade: margin x leverage, then Arcus
  // preflight), so there is no notionalUsd field to recompute here — the
  // override applies to the next /ratio / /etf open.
  return {
    key,
    summary:
      `${label} trade margin: $${valueUsd.toFixed(2)} per leg ` +
      `(notional $${(valueUsd * cfg.leverage).toFixed(2)} ` +
      `at ${cfg.leverage}x)`,
  };
}

function applyPairLeverage(
  config: BotConfig,
  section: ArcusPairSection,
  key: RuntimeSettingKey,
  label: string,
  leverage: number,
): RuntimeSettingChange {
  if (
    !Number.isInteger(leverage) ||
    leverage < 1 ||
    leverage > MAX_LEVERAGE
  ) {
    throw new Error(`Leverage must be an integer between 1 and ${MAX_LEVERAGE}.`);
  }
  const cfg = config[section];
  cfg.leverage = leverage;
  // No exchange write here: createMetalTrade runs validateExecutionPreflight
  // against Arcus with this leverage at the next entry, so an unsupported
  // value fails closed there instead of mutating the account now.
  return {
    key,
    summary:
      `${label} trade leverage: ${leverage}x ` +
      `(notional $${(Number(cfg.marginUsd) * leverage).toFixed(2)} per leg ` +
      `with margin $${Number(cfg.marginUsd).toFixed(2)})`,
  };
}

function applyPairTpMinNetUsd(
  config: BotConfig,
  section: ArcusPairSection,
  key: RuntimeSettingKey,
  label: string,
  valueUsd: number,
): RuntimeSettingChange {
  if (!Number.isFinite(valueUsd) || valueUsd <= 0 || valueUsd > MAX_USD_VALUE) {
    throw new Error("TP floor must be between 0 and 10000 USD.");
  }
  config[section].tpMinNetUsd = valueUsd.toFixed(2);
  // Feeds BOTH profit paths evaluated every tick: the limit TP
  // (net ≥ breakeven + floor) and the /trade armed market close
  // (threshold snapshotted from this value at arm time).
  return {
    key,
    summary: `${label} TP floor: +$${valueUsd.toFixed(2)} net over breakeven`,
  };
}

/** Max entry slippage ceiling, same as the env parse: the value must stay
 * under the Arcus 10%-of-mark hard bound that rejects out-of-band market
 * bounds. */
const MAX_PAIR_ENTRY_SLIPPAGE_BPS = 950;
const MAX_PAIR_HEDGE_RETRIES = 10;

function applyPairMaxEntrySlippageBps(
  config: BotConfig,
  section: ArcusPairSection,
  key: RuntimeSettingKey,
  label: string,
  bps: number,
): RuntimeSettingChange {
  if (
    !Number.isInteger(bps) ||
    bps < 1 ||
    bps > MAX_PAIR_ENTRY_SLIPPAGE_BPS
  ) {
    throw new Error(
      `${label} max entry slippage must be an integer between 1 and ${MAX_PAIR_ENTRY_SLIPPAGE_BPS} bps.`,
    );
  }
  config[section].maxEntrySlippageBps = bps;
  // Consumed by BOTH orderbook-gate consumers: the createMetalTrade
  // order-book gate (book-walk slippage + hedge taker fee + entry maker
  // fee ceiling that refuses the entry) and the hedge order price bound
  // (touch ∓ this many bps) in hedgeIncrement.
  return {
    key,
    summary: `${label} max entry slippage: ${bps} bps (order-book gate + hedge bound)`,
  };
}

function applyPairHedgeRetries(
  config: BotConfig,
  section: ArcusPairSection,
  key: RuntimeSettingKey,
  label: string,
  attempts: number,
): RuntimeSettingChange {
  if (
    !Number.isInteger(attempts) ||
    attempts < 1 ||
    attempts > MAX_PAIR_HEDGE_RETRIES
  ) {
    throw new Error(
      `${label} hedge retries must be an integer between 1 and ${MAX_PAIR_HEDGE_RETRIES}.`,
    );
  }
  config[section].hedgeRetryAttempts = attempts;
  return {
    key,
    summary: `${label} hedge retries: ${attempts} attempts`,
  };
}

export function applyMetalMarginUsd(
  config: BotConfig,
  valueUsd: number,
): RuntimeSettingChange {
  return applyPairMarginUsd(config, "goldSilver", "metalMarginUsd", "Metal", valueUsd);
}

export function applyMetalLeverage(
  config: BotConfig,
  leverage: number,
): RuntimeSettingChange {
  return applyPairLeverage(config, "goldSilver", "metalLeverage", "Metal", leverage);
}

export function applyMetalTpMinNetUsd(
  config: BotConfig,
  valueUsd: number,
): RuntimeSettingChange {
  return applyPairTpMinNetUsd(config, "goldSilver", "metalTpMinNetUsd", "Metal", valueUsd);
}

export function applyMetalMaxEntrySlippageBps(
  config: BotConfig,
  bps: number,
): RuntimeSettingChange {
  return applyPairMaxEntrySlippageBps(config, "goldSilver", "metalMaxEntrySlippageBps", "Metal", bps);
}

export function applyMetalHedgeRetries(
  config: BotConfig,
  attempts: number,
): RuntimeSettingChange {
  return applyPairHedgeRetries(config, "goldSilver", "metalHedgeRetries", "Metal", attempts);
}

export function applyEtfMarginUsd(
  config: BotConfig,
  valueUsd: number,
): RuntimeSettingChange {
  return applyPairMarginUsd(config, "spyQqq", "etfMarginUsd", "ETF", valueUsd);
}

export function applyEtfLeverage(
  config: BotConfig,
  leverage: number,
): RuntimeSettingChange {
  return applyPairLeverage(config, "spyQqq", "etfLeverage", "ETF", leverage);
}

export function applyEtfTpMinNetUsd(
  config: BotConfig,
  valueUsd: number,
): RuntimeSettingChange {
  return applyPairTpMinNetUsd(config, "spyQqq", "etfTpMinNetUsd", "ETF", valueUsd);
}

export function applyEtfMaxEntrySlippageBps(
  config: BotConfig,
  bps: number,
): RuntimeSettingChange {
  return applyPairMaxEntrySlippageBps(config, "spyQqq", "etfMaxEntrySlippageBps", "ETF", bps);
}

export function applyEtfHedgeRetries(
  config: BotConfig,
  attempts: number,
): RuntimeSettingChange {
  return applyPairHedgeRetries(config, "spyQqq", "etfHedgeRetries", "ETF", attempts);
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
    summary: `Auto-confirm (auto-trading): ${enabled ? "ON" : "off"}`,
  };
}

/** Switch the strategy pair at runtime. Every downstream consumer reads
 * `config.btcSymbol` per use (polling loop, signal engine, open-trade
 * previews, execution), so mutating it in place propagates without a
 * restart. The symbol must come from the shared TRADING_PAIRS catalog —
 * the exchange side resolves it by base-asset matching, so no per-exchange
 * mapping is needed. Caller is responsible for the active-trade guard and
 * the per-symbol execution preflight (see the Telegram Pairs panel). */
export function applyTradingPair(
  config: BotConfig,
  symbol: string,
): RuntimeSettingChange {
  const normalized = symbol.trim().toUpperCase();
  if (!isSupportedTradingSymbol(normalized)) {
    const available = TRADING_PAIRS.map((pair) => pair.label).join(", ");
    throw new Error(
      `Unsupported pair: ${symbol}. Available pairs: ${available}.`,
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
    case "leverage":
      return config.leverage !== baseline.leverage;
    case "autoConfirm":
      return config.openTrade.autoConfirm !== baseline.autoConfirm;
    case "tradingPair":
      return config.btcSymbol !== baseline.tradingPair;
    case "metalMarginUsd":
      return config.goldSilver.marginUsd !== baseline.metalMarginUsd;
    case "metalLeverage":
      return config.goldSilver.leverage !== baseline.metalLeverage;
    case "metalTpMinNetUsd":
      return config.goldSilver.tpMinNetUsd !== baseline.metalTpMinNetUsd;
    case "metalMaxEntrySlippageBps":
      return (
        config.goldSilver.maxEntrySlippageBps !==
        baseline.metalMaxEntrySlippageBps
      );
    case "metalHedgeRetries":
      return config.goldSilver.hedgeRetryAttempts !== baseline.metalHedgeRetries;
    case "etfMarginUsd":
      return config.spyQqq.marginUsd !== baseline.etfMarginUsd;
    case "etfLeverage":
      return config.spyQqq.leverage !== baseline.etfLeverage;
    case "etfTpMinNetUsd":
      return config.spyQqq.tpMinNetUsd !== baseline.etfTpMinNetUsd;
    case "etfMaxEntrySlippageBps":
      return (
        config.spyQqq.maxEntrySlippageBps !==
        baseline.etfMaxEntrySlippageBps
      );
    case "etfHedgeRetries":
      return config.spyQqq.hedgeRetryAttempts !== baseline.etfHedgeRetries;
  }
}
