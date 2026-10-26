import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeRsi, type MetalRatioSide } from "@btc-arbitrage/domain";
import type { GoldSilverCandleTimeframe } from "@btc-arbitrage/config";
import type { MetalRatioBucket } from "./metal-ratio-warmup.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
// The renderer ships next to the compiled output (the bot build copies the
// .py into dist — see apps/bot/package.json). Resolved from the JS module
// location so both `tsx` source runs and compiled `dist` runs find it.
const RENDERER_PATH = join(moduleDir, "metal-ratio-chart.py");

export interface MetalRatioChartLive {
  rsi?: string;
  side?: MetalRatioSide;
  ratio?: string;
  goldPriceUsd?: string;
  silverPriceUsd?: string;
  calculatedAt?: Date;
}

export interface MetalRatioChartResult {
  png: Buffer;
  candles: number;
  lastClose: string;
}

/** Renders the TradingView-style PNG from pre-built ratio OHLC buckets.
 * The data source is the caller's choice (Yahoo futures for /ratio; the
 * Arcus engine keeps its own candle path). Throws with an
 * operator-friendly message when python3/Pillow is unavailable. */
export async function renderMetalRatioChart(input: {
  buckets: MetalRatioBucket[];
  timeframe: GoldSilverCandleTimeframe;
  rsiPeriod: number;
  title?: string;
  live?: MetalRatioChartLive;
}): Promise<MetalRatioChartResult> {
  const buckets = input.buckets.slice(-200); // RSI warmup depth
  if (buckets.length < 2) {
    throw new Error("Not enough candle data to render the ratio chart");
  }

  const closes = buckets.map((bucket) => bucket.ratio);
  const rsiSeries = buckets.map((bucket, index) => {
    const rsi =
      index === 0
        ? undefined
        : computeRsi(closes.slice(0, index + 1), input.rsiPeriod);
    return {
      timestamp: bucket.openTimeMs,
      value: rsi === undefined ? null : Number(rsi),
    };
  });

  const liveRsi = input.live?.rsi ? Number(input.live.rsi) : null;
  const payload = {
    candles: buckets.map((bucket) => ({
      timestamp: bucket.openTimeMs,
      open: Number(bucket.open),
      high: Number(bucket.high),
      low: Number(bucket.low),
      close: Number(bucket.close),
    })),
    rsi: rsiSeries,
    meta: {
      symbol: input.title ?? "GOLDSILVER",
      timeframe: input.timeframe,
      rsiPeriod: input.rsiPeriod,
      liveRsi,
      side: input.live?.side ?? null,
    },
  };

  const png = await runRenderer(payload);
  return {
    png,
    candles: buckets.length,
    lastClose: buckets[buckets.length - 1].close,
  };
}

function runRenderer(payload: unknown): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [RENDERER_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      reject(
        new Error(
          `Chart renderer unavailable (python3): ${error.message}. ` +
            "Install python3 + Pillow (pillow) in the bot image.",
        ),
      );
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      reject(
        new Error(
          `Chart renderer exited ${code}${detail ? `: ${detail}` : ""}`,
        ),
      );
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}
