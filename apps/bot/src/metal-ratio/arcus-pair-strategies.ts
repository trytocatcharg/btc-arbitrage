import {
  GOLD_SILVER_SYMBOL,
  SPYQQQ_SYMBOL,
  isArcusPairSymbol,
  type ArcusPairSymbol,
} from "@btc-arbitrage/domain";

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
  },
  [SPYQQQ_SYMBOL]: {
    symbol: SPYQQQ_SYMBOL,
    label: "ETFs",
    emoji: "📈",
    entryMarket: "SPY-USD",
    hedgeMarket: "QQQ-USD",
    yahooSymbols: ["SPY", "QQQ"],
  },
};

export function getArcusPairStrategy(
  symbol: string,
): ArcusPairStrategySpec | undefined {
  return isArcusPairSymbol(symbol)
    ? ARCUS_PAIR_STRATEGIES[symbol as ArcusPairSymbol]
    : undefined;
}
