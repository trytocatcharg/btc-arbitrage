import type { ArcusPairCandleTimeframe } from "@btc-arbitrage/config";
import { formatDecimal } from "@btc-arbitrage/domain";
import type { MetalRatioBucket } from "./metal-ratio-warmup.js";

/**
 * Yahoo Finance unofficial chart feed for ratio-chart candles. Used by
 * /ratio and /etf to render a TradingView-faithful chart of the
 * strategy's ratio: each Arcus-pair strategy supplies its Yahoo symbol
 * pair (metals: the COMEX futures GC=F/SI=F ≈ TVC:GOLDSILVER at ~99.6%,
 * verified live 2026-10-25; SPYQQQ: the SPY/QQQ ETFs, direct and liquid).
 * No API key required. The endpoint is unofficial and can change without
 * notice — failures must surface as friendly errors, never crash the bot.
 */
const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";

/** Yahoo `interval` values supported per bot timeframe. Timeframes without
 * a Yahoo equivalent throw a friendly error (the chart is a display-only
 * feature — the strategy engine keeps its own Arcus candle source). */
const INTERVAL_BY_TIMEFRAME: Partial<Record<ArcusPairCandleTimeframe, string>> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1h",
  "1d": "1d",
  "1w": "1wk",
};

/** Yahoo `range` per timeframe: deep enough for a 200-candle RSI warmup.
 * (1h futures trade ~20 h/day, so 1 month ≈ 440 candles.) */
const RANGE_BY_TIMEFRAME: Partial<Record<ArcusPairCandleTimeframe, string>> = {
  "1m": "5d",
  "5m": "1mo",
  "15m": "1mo",
  "30m": "1mo",
  "1h": "1mo",
  "1d": "6mo",
  "1w": "1y",
};

export interface YahooCandle {
  timestampMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface YahooChartQuote {
  open?: Array<number | null>;
  high?: Array<number | null>;
  low?: Array<number | null>;
  close?: Array<number | null>;
}

async function fetchYahooCandles(
  symbol: string,
  interval: string,
  range: string,
): Promise<YahooCandle[]> {
  const url = `${YAHOO_CHART_URL}/${symbol}?interval=${interval}&range=${range}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let payload: unknown;
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; btc-arbitrage-bot)" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Yahoo chart ${symbol} failed with HTTP ${response.status}`);
    }
    payload = await response.json();
  } finally {
    clearTimeout(timer);
  }

  const chart = payload as {
    chart?: {
      result?: Array<{
        timestamp?: number[];
        indicators?: { quote?: YahooChartQuote[] };
      }>;
      error?: { description?: string };
    };
  };
  const result = chart.chart?.result?.[0];
  if (!result || !Array.isArray(result.timestamp)) {
    throw new Error(
      `Yahoo chart ${symbol}: ${chart.chart?.error?.description ?? "no data"}`,
    );
  }
  const quote = result.indicators?.quote?.[0];
  if (!quote?.close) {
    throw new Error(`Yahoo chart ${symbol}: empty quote payload`);
  }

  const candles: YahooCandle[] = [];
  for (let i = 0; i < result.timestamp.length; i += 1) {
    const close = quote.close[i];
    if (close == null) continue; // holiday/session gaps arrive as nulls
    candles.push({
      timestampMs: result.timestamp[i] * 1000,
      open: quote.open?.[i] ?? close,
      high: quote.high?.[i] ?? close,
      low: quote.low?.[i] ?? close,
      close,
    });
  }
  return candles;
}

export interface YahooRatioSeries {
  buckets: MetalRatioBucket[];
  lastEntryClose: number;
  lastHedgeClose: number;
}

/** Fetches the strategy's two Yahoo symbols, aligns by exact timestamp
 * (same exchange feed), and derives the ratio OHLC: open/close from
 * same-bucket values, high = entry.high / hedge.low, low = entry.low /
 * hedge.high. */
export async function loadYahooRatioBuckets(input: {
  /** (entry, hedge) Yahoo symbols, e.g. ["GC=F","SI=F"] or ["SPY","QQQ"]. */
  symbols: [string, string];
  timeframe: ArcusPairCandleTimeframe;
}): Promise<YahooRatioSeries> {
  const interval = INTERVAL_BY_TIMEFRAME[input.timeframe];
  const range = RANGE_BY_TIMEFRAME[input.timeframe];
  if (!interval || !range) {
    throw new Error(
      `Timeframe ${input.timeframe} is not supported by the Yahoo chart source (supported: 1m, 5m, 15m, 30m, 1h, 1d, 1w)`,
    );
  }

  const [entryCandles, hedgeCandles] = await Promise.all([
    fetchYahooCandles(input.symbols[0], interval, range),
    fetchYahooCandles(input.symbols[1], interval, range),
  ]);
  if (entryCandles.length === 0 || hedgeCandles.length === 0) {
    throw new Error(
      `Yahoo returned no candles for ${input.symbols[0]} or ${input.symbols[1]}`,
    );
  }

  const hedgeByTs = new Map(
    hedgeCandles.map((candle) => [candle.timestampMs, candle]),
  );
  const buckets: MetalRatioBucket[] = [];
  for (const candle of entryCandles) {
    const hedgeCandle = hedgeByTs.get(candle.timestampMs);
    if (!hedgeCandle) continue;
    const ratioOf = (entryPrice: number, hedgePrice: number): string =>
      formatDecimal(entryPrice / hedgePrice, 8);
    buckets.push({
      openTimeMs: candle.timestampMs,
      open: ratioOf(candle.open, hedgeCandle.open),
      high: ratioOf(candle.high, hedgeCandle.low),
      low: ratioOf(candle.low, hedgeCandle.high),
      close: ratioOf(candle.close, hedgeCandle.close),
      ratio: ratioOf(candle.close, hedgeCandle.close),
    });
  }
  if (buckets.length < 2) {
    throw new Error("Yahoo candles did not align (no shared timestamps)");
  }
  return {
    buckets,
    lastEntryClose: entryCandles[entryCandles.length - 1].close,
    lastHedgeClose: hedgeCandles[hedgeCandles.length - 1].close,
  };
}
