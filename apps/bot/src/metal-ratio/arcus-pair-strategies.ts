import {
  GOLD_SILVER_SYMBOL,
  SPYQQQ_SYMBOL,
  isArcusPairSymbol,
  type ArcusPairSymbol,
} from "@btc-arbitrage/domain";
import type { ArcusPairStrategyConfig, BotConfig } from "@btc-arbitrage/config";

/** Spec of one Arcus pair-trade strategy. Both legs live on Arcus
 * (operator decision 2026-10-27): the entry leg rests a passive post-only
 * ALO limit, the hedge leg fills immediately as a bounded IOC market order
 * gated by the L2 order-book simulation.
 *
 * Invariant: the entry asset's price is ALWAYS the higher of the pair
 * (GLD > SLV, SPY > QQQ), so with dollar-neutral legs the entry leg's
 * base quantity is always the SMALLER one — that asymmetry is how the
 * trade side is derived from fills (see metal-trade-service). */
export interface ArcusPairStrategySpec {
  /** Pseudo-symbol stored on trades.symbol (also the registry key). */
  symbol: ArcusPairSymbol;
  /** Telegram label (config submenu, notices). */
  label: string;
  /** Telegram emoji prefix. */
  emoji: string;
  /** Passive ALO entry leg market (GLD-USD / SPY-USD). */
  entryMarket: string;
  /** Immediate IOC hedge leg market (SLV-USD / QQQ-USD); also the market
   * the order-book entry gate simulates. */
  hedgeMarket: string;
  /** Yahoo Finance symbols for the ratio chart / RSI candles, in
   * (entry, hedge) order. Metals use the futures pair GC=F/SI=F (tracks
   * TVC:GOLDSILVER at ~99.6%); SPYQQQ uses the liquid ETFs directly. */
  yahooSymbols: [string, string];
  /** Env var family of the strategy's config section (GOLDSILVER /
   * SPYQQQ), used to name variables in operator-facing errors. */
  envPrefix: "GOLDSILVER" | "SPYQQQ";
  /** Base asset of each leg market, for operator-facing labels
   * ("SHORT GLD / LONG SLV" / "SHORT SPY / LONG QQQ"). */
  entryAsset: string;
  hedgeAsset: string;
}

export const ARCUS_PAIR_STRATEGIES: Record<
  ArcusPairSymbol,
  ArcusPairStrategySpec
> = {
  [GOLD_SILVER_SYMBOL]: {
    symbol: GOLD_SILVER_SYMBOL,
    label: "Metals",
    emoji: "🥇",
    entryMarket: "GLD-USD",
    hedgeMarket: "SLV-USD",
    yahooSymbols: ["GC=F", "SI=F"],
    envPrefix: "GOLDSILVER",
    entryAsset: "GLD",
    hedgeAsset: "SLV",
  },
  [SPYQQQ_SYMBOL]: {
    symbol: SPYQQQ_SYMBOL,
    label: "ETFs",
    emoji: "📈",
    entryMarket: "SPY-USD",
    hedgeMarket: "QQQ-USD",
    yahooSymbols: ["SPY", "QQQ"],
    envPrefix: "SPYQQQ",
    entryAsset: "SPY",
    hedgeAsset: "QQQ",
  },
};

export function getArcusPairStrategy(
  symbol: string,
): ArcusPairStrategySpec | undefined {
  return isArcusPairSymbol(symbol)
    ? ARCUS_PAIR_STRATEGIES[symbol as ArcusPairSymbol]
    : undefined;
}

/** getArcusPairStrategy that fails loudly on an unknown symbol — for call
 * sites that already know the row is an Arcus-pair trade. */
export function requireArcusPairStrategy(
  symbol: string,
): ArcusPairStrategySpec {
  const spec = getArcusPairStrategy(symbol);
  if (!spec) throw new Error(`Unknown Arcus-pair strategy symbol: ${symbol}`);
  return spec;
}

/** Resolve the BotConfig section for a strategy symbol (GOLDSILVER ->
 * config.goldSilver, SPYQQQ -> config.spyQqq). Callers pass only symbols
 * already validated as Arcus-pair (requireArcusPairStrategy). */
export function resolveArcusPairConfig(
  config: BotConfig,
  symbol: string,
): ArcusPairStrategyConfig {
  return symbol === SPYQQQ_SYMBOL ? config.spyQqq : config.goldSilver;
}
