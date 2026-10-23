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

/** Stateful gold/silver ratio engine: holds the ratio close series, the
 * current confirmed side, and the last alert timestamp (cooldown). */
export class MetalRatioEngine {
  private closes: string[] = [];
  private currentSide: MetalRatioSide | undefined;
  private lastAlertAtMs = 0;

  constructor(private readonly options: MetalRatioEngineOptions) {}

  /** Seeds the close series from warmup candle ratios (oldest first).
   * The confirmed side starts undefined, so the first post-warmup tick
   * whose RSI is outside the dead zone reports `crossed: true` — an
   * intentional boot-time regime announcement. */
  init(closes: readonly string[]): void {
    this.closes = closes.slice(-MAX_CLOSES);
    this.currentSide = undefined;
  }

  onTick(input: MetalRatioTickInput): MetalRatioTickResult {
    const ratio = computeMetalRatio(input.goldPriceUsd, input.silverPriceUsd);
    this.closes.push(ratio);
    if (this.closes.length > MAX_CLOSES) {
      this.closes.splice(0, this.closes.length - MAX_CLOSES);
    }

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

  /** Cooldown gate for cross alerts. Returns true (and stamps the attempt)
   * when no alert was sent within `cooldownMs`; callers invoke this only
   * on cross ticks. */
  consumeAlertEligibility(cooldownMs: number, nowMs = Date.now()): boolean {
    if (cooldownMs > 0 && this.lastAlertAtMs > 0) {
      if (nowMs - this.lastAlertAtMs < cooldownMs) return false;
    }
    this.lastAlertAtMs = nowMs;
    return true;
  }

  /** Read-only view for logging/diagnostics. */
  getState(): { closesCount: number; currentSide?: MetalRatioSide } {
    return { closesCount: this.closes.length, currentSide: this.currentSide };
  }
}
