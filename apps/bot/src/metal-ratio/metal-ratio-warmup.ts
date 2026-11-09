import {
  computeMetalRatio,
  GOLD_SILVER_SYMBOL,
} from "@btc-arbitrage/domain";
import type { ArcusPairCandleTimeframe } from "@btc-arbitrage/config";
import type { ArcusMarketDataClient } from "../exchanges/arcus/arcus-client.js";
import type { ArcusCandle } from "../exchanges/arcus/arcus.types.js";
import { ARCUS_PAIR_STRATEGIES } from "./arcus-pair-strategies.js";

/** Metal-strategy leg markets, re-exported from the GOLDSILVER spec so the
 * registry stays the single source of truth for pair identities. */
export const GOLD_MARKET =
  ARCUS_PAIR_STRATEGIES[GOLD_SILVER_SYMBOL].entryMarket;
export const SILVER_MARKET =
  ARCUS_PAIR_STRATEGIES[GOLD_SILVER_SYMBOL].hedgeMarket;

/** Candle timeframe durations in milliseconds, matching
 * ARCUS_PAIR_CANDLE_TIMEFRAMES in packages/config. Exported for the
 * polling loop's staleness re-warmup check. */
export const ARCUS_PAIR_TIMEFRAME_MS: Record<
  ArcusPairCandleTimeframe,
  number
> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "8h": 28_800_000,
  "12h": 43_200_000,
  "1d": 86_400_000,
  "3d": 259_200_000,
  "1w": 604_800_000,
};

/** Aligned ratio candle buckets (final candles only, oldest first) with
 * their open timestamps — the shared shape behind the warmup closes
 * loader and the /ratio snapshot renderer. Ratio OHLC derives from the
 * two underlying markets: open/close use same-bucket closes, high is the
 * widest gold-high over silver-low, low the inverse. */
export interface MetalRatioBucket {
  openTimeMs: number;
  open: string;
  high: string;
  low: string;
  close: string;
  /** The bucket's ratio close (== close; kept as a named alias for the
   * warmup closes path). */
  ratio: string;
}

/** Fetches candle history for the strategy's two leg markets, aligns
 * buckets by openTime, and returns per-bucket ratio closes OLDEST-first
 * (the input shape computeRsi expects). Graceful on partial data: the
 * in-progress candle (isFinal === false), buckets missing on either side,
 * and invalid closes are skipped; an unusable response resolves to an
 * empty array so the caller can start cold (RSI stays undefined until
 * enough live ticks). */
export async function loadMetalRatioWarmupCloses(input: {
  client: ArcusMarketDataClient;
  /** (entry, hedge) Arcus markets, e.g. ["GLD-USD","SLV-USD"]. */
  markets: [string, string];
  timeframe: ArcusPairCandleTimeframe;
  candleLimit: number;
  nowMs?: number;
}): Promise<string[]> {
  const buckets = await loadMetalRatioCandleSeries(input);
  return buckets.map((bucket) => bucket.ratio);
}

/** Same fetch/alignment as loadMetalRatioWarmupCloses but keeps the
 * bucket timestamps for display. */
export async function loadMetalRatioCandleSeries(input: {
  client: ArcusMarketDataClient;
  /** (entry, hedge) Arcus markets, e.g. ["GLD-USD","SLV-USD"]. */
  markets: [string, string];
  timeframe: ArcusPairCandleTimeframe;
  candleLimit: number;
  nowMs?: number;
}): Promise<MetalRatioBucket[]> {
  const timeframeMs = ARCUS_PAIR_TIMEFRAME_MS[input.timeframe];
  const toUs = (input.nowMs ?? Date.now()) * 1_000;
  const fromUs = toUs - timeframeMs * input.candleLimit * 1_000;

  const [entryCandles, hedgeCandles] = await Promise.all([
    input.client.getCandles({
      market: input.markets[0],
      timeframe: input.timeframe,
      fromUs,
      toUs,
    }),
    input.client.getCandles({
      market: input.markets[1],
      timeframe: input.timeframe,
      fromUs,
      toUs,
    }),
  ]);

  const hedgeByOpenTime = new Map<string, ArcusCandle>();
  for (const candle of finalCandlesOldestFirst(hedgeCandles)) {
    if (candle.openTime === undefined || candle.close === undefined) continue;
    hedgeByOpenTime.set(String(candle.openTime), candle);
  }

  const buckets: MetalRatioBucket[] = [];
  for (const candle of finalCandlesOldestFirst(entryCandles)) {
    if (candle.openTime === undefined || candle.close === undefined) continue;
    const hedge = hedgeByOpenTime.get(String(candle.openTime));
    if (!hedge || hedge.close === undefined) continue;
    try {
      buckets.push({
        openTimeMs: Number(candle.openTime) / 1_000,
        open: computeMetalRatio(candle.open ?? candle.close, hedge.open ?? hedge.close),
        high: computeMetalRatio(candle.high ?? candle.close, hedge.low ?? hedge.close),
        low: computeMetalRatio(candle.low ?? candle.close, hedge.high ?? hedge.close),
        close: computeMetalRatio(candle.close, hedge.close),
        ratio: computeMetalRatio(candle.close, hedge.close),
      });
    } catch {
      // Skip buckets with non-positive/invalid prices instead of aborting
      // the whole series on one bad row.
    }
  }
  return buckets;
}

/** The API returns candles newest-first with the in-progress bucket flagged
 * isFinal=false; RSI closes must be final buckets ordered oldest-first. */
function finalCandlesOldestFirst(candles: ArcusCandle[]): ArcusCandle[] {
  return candles
    .filter((candle) => candle.isFinal !== false)
    .slice()
    .sort((a, b) => Number(a.openTime ?? 0) - Number(b.openTime ?? 0));
}
