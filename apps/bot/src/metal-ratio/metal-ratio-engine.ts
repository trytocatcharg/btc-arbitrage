import {
  computeMetalRatio,
  computeRsi,
  rsiToSide,
  type MetalRatioSide,
} from "@btc-arbitrage/domain";

/** Hard cap on the in-memory ratio close series. Warmup seeds at most
 * candleLimit (<= 200) closes and live ticks append one per poll, so this
 * bound keeps memory flat over long runs while leaving ample history for
 * the Wilder RSI smoothing to stay warm. */
const MAX_CLOSES = 500;

export interface MetalRatioEngineOptions {
  rsiPeriod: number;
  /** Decimal string band around RSI 50 (matches rsiToSide). */
  rsiConfirmBand: string;
  /** Candle timeframe in milliseconds. Live ticks are bucketed by this
   * granularity so the in-memory close series stays homogeneous with the
   * candle warmup: the forming bucket's ratio is refreshed per tick and
   * committed as one close when the bucket rolls — otherwise the RSI
   * would silently become a per-poll (1 s) momentum reading a few
   * minutes after boot. */
  timeframeMs: number;
}

export interface MetalRatioTickInput {
  goldPriceUsd: string;
  silverPriceUsd: string;
  calculatedAt: Date;
}

export interface MetalRatioTickResult {
  ratio: string;
  /** Undefined until the close series is long enough for the RSI period. */
  rsi?: string;
  /** Defined only when the RSI is outside the dead zone around 50. */
  side?: MetalRatioSide;
  /** True only when `side` is defined and differs from the previous
   * confirmed side (hysteresis: dead-zone ticks never reset the side). */
  crossed: boolean;
}

/** Stateful gold/silver ratio engine: holds the ratio close series and the
 * current confirmed side.
 *
 * Close-series semantics: one close per COMPLETED candle bucket. `onTick`
 * updates the forming bucket's ratio and commits it to the series only
 * when the bucket advances, matching how the warmup candle closes are
 * built and how TradingView's timeframe RSI behaves. */
export class MetalRatioEngine {
  private closes: string[] = [];
  private currentSide: MetalRatioSide | undefined;
  private currentBucketStartMs: number | undefined;
  private pendingBucketRatio: string | undefined;

  constructor(private readonly options: MetalRatioEngineOptions) {}

  /** Seeds the close series from warmup candle ratios (oldest first).
   * The confirmed side starts undefined, so the first post-warmup tick
   * whose RSI is outside the dead zone reports `crossed: true` — an
   * intentional boot-time regime announcement. */
  init(closes: readonly string[]): void {
    this.closes = closes.slice(-MAX_CLOSES);
    this.currentSide = undefined;
    this.currentBucketStartMs = undefined;
    this.pendingBucketRatio = undefined;
  }

  onTick(input: MetalRatioTickInput): MetalRatioTickResult {
    const ratio = computeMetalRatio(input.goldPriceUsd, input.silverPriceUsd);
    const bucketStartMs =
      Math.floor(input.calculatedAt.getTime() / this.options.timeframeMs) *
      this.options.timeframeMs;

    if (this.currentBucketStartMs === undefined) {
      // First tick after init: the forming bucket has no committed close
      // yet (warmup covers only completed buckets). Track it without
      // pushing, so the series stays completed-buckets-only.
      this.currentBucketStartMs = bucketStartMs;
      this.pendingBucketRatio = ratio;
    } else if (bucketStartMs === this.currentBucketStartMs) {
      // Same candle still forming: refresh its pending close.
      this.pendingBucketRatio = ratio;
    } else if (bucketStartMs > this.currentBucketStartMs) {
      // Bucket rolled: commit the completed bucket's last ratio.
      if (this.pendingBucketRatio !== undefined) {
        this.closes.push(this.pendingBucketRatio);
        if (this.closes.length > MAX_CLOSES) {
          this.closes.splice(0, this.closes.length - MAX_CLOSES);
        }
      }
      this.currentBucketStartMs = bucketStartMs;
      this.pendingBucketRatio = ratio;
    }
    // bucketStartMs < current (out-of-order clock): keep the existing
    // pending close; the next in-order tick resumes the normal path.

    const rsi = computeRsi(this.closes, this.options.rsiPeriod);
    if (rsi === undefined) {
      return { ratio, rsi: undefined, side: undefined, crossed: false };
    }

    const side = rsiToSide(rsi, this.options.rsiConfirmBand);
    let crossed = false;
    if (side !== undefined && side !== this.currentSide) {
      crossed = true;
      this.currentSide = side;
    }
    return { ratio, rsi, side, crossed };
  }

  /** Read-only view for logging/diagnostics. */
  getState(): { closesCount: number; currentSide?: MetalRatioSide } {
    return { closesCount: this.closes.length, currentSide: this.currentSide };
  }
}
