import { computeMetalRatio } from "@btc-arbitrage/domain";
import type { GoldSilverCandleTimeframe } from "@btc-arbitrage/config";
import type { ArcusMarketDataClient } from "../exchanges/arcus/arcus-client.js";
import type { ArcusCandle } from "../exchanges/arcus/arcus.types.js";

export const GOLD_MARKET = "GLD-USD";
export const SILVER_MARKET = "SLV-USD";

/** Candle timeframe durations in milliseconds, matching
 * GOLD_SILVER_CANDLE_TIMEFRAMES in packages/config. Exported for the
 * polling loop's staleness re-warmup check. */
export const GOLD_SILVER_TIMEFRAME_MS: Record<
  GoldSilverCandleTimeframe,
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

/** Fetches candle history for GLD-USD and SLV-USD, aligns buckets by
 * openTime, and returns per-bucket ratio closes OLDEST-first (the input
 * shape computeRsi expects). Graceful on partial data: the in-progress
 * candle (isFinal === false), buckets missing on either side, and invalid
 * closes are skipped; an unusable response resolves to an empty array so
 * the caller can start cold (RSI stays undefined until enough live ticks). */
export async function loadMetalRatioWarmupCloses(input: {
  client: ArcusMarketDataClient;
  timeframe: GoldSilverCandleTimeframe;
  candleLimit: number;
  nowMs?: number;
}): Promise<string[]> {
  const timeframeMs = GOLD_SILVER_TIMEFRAME_MS[input.timeframe];
  const toUs = (input.nowMs ?? Date.now()) * 1_000;
  const fromUs = toUs - timeframeMs * input.candleLimit * 1_000;

  const [goldCandles, silverCandles] = await Promise.all([
    input.client.getCandles({
      market: GOLD_MARKET,
      timeframe: input.timeframe,
      fromUs,
      toUs,
    }),
    input.client.getCandles({
      market: SILVER_MARKET,
      timeframe: input.timeframe,
      fromUs,
      toUs,
    }),
  ]);

  const silverCloseByOpenTime = new Map<string, string>();
  for (const candle of finalCandlesOldestFirst(silverCandles)) {
    if (candle.openTime === undefined || candle.close === undefined) continue;
    silverCloseByOpenTime.set(String(candle.openTime), candle.close);
  }

  const closes: string[] = [];
  for (const candle of finalCandlesOldestFirst(goldCandles)) {
    if (candle.openTime === undefined || candle.close === undefined) continue;
    const silverClose = silverCloseByOpenTime.get(String(candle.openTime));
    if (silverClose === undefined) continue;
    try {
      closes.push(computeMetalRatio(candle.close, silverClose));
    } catch {
      // Skip buckets with non-positive/invalid prices instead of aborting
      // the whole warmup on one bad row.
    }
  }
  return closes;
}

/** The API returns candles newest-first with the in-progress bucket flagged
 * isFinal=false; RSI closes must be final buckets ordered oldest-first. */
function finalCandlesOldestFirst(candles: ArcusCandle[]): ArcusCandle[] {
  return candles
    .filter((candle) => candle.isFinal !== false)
    .slice()
    .sort((a, b) => Number(a.openTime ?? 0) - Number(b.openTime ?? 0));
}
