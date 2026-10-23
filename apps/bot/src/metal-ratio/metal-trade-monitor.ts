import { eq } from "drizzle-orm";
import { parseDecimal, type MetalRatioSide } from "@btc-arbitrage/domain";
import { tradeLegs } from "@btc-arbitrage/db";
import { GOLD_MARKET } from "./metal-ratio-warmup.js";
import {
  closeMetalTrade,
  loadActiveMetalTrade,
  metalLegMarkets,
  type MetalTradeContext,
} from "./metal-trade-service.js";

export interface MetalMonitorContext extends MetalTradeContext {
  /** Serial execution queue: close jobs run decoupled from the tick. */
  enqueue: (job: { description: string; run: () => Promise<void> }) => void;
}

export interface MetalTriggerTick {
  /** True on the tick where the ratio RSI crossed into a new side. */
  crossed: boolean;
  side: MetalRatioSide | undefined;
  goldPriceUsd: string;
  silverPriceUsd: string;
}

/** Per-tick exit-trigger evaluation for the active gold/silver trade.
 * Idempotent and cheap: exactly one trigger path wins because
 * closeMetalTrade claims open -> closing atomically; enqueued duplicates
 * no-op on the claim. */
export async function evaluateMetalTradeExitTriggers(
  ctx: MetalMonitorContext,
  tick: MetalTriggerTick,
): Promise<void> {
  const trade = await loadActiveMetalTrade(ctx);
  if (!trade || trade.status !== "open") return;

  const legs = await ctx.db
    .select()
    .from(tradeLegs)
    .where(eq(tradeLegs.tradeId, trade.id));
  if (legs.length === 0) return;
  const { goldLeg } = metalLegMarkets(trade.side);

  let grossPnl = 0;
  let entryFees = 0;
  let remainingNotional = 0;
  for (const leg of legs) {
    const entry = leg.entryPriceUsd
      ? parseDecimal(String(leg.entryPriceUsd), "entry")
      : 0;
    const qty = leg.quantityBase
      ? parseDecimal(String(leg.quantityBase), "qty")
      : 0;
    const mark =
      leg.side === goldLeg.side
        ? parseDecimal(tick.goldPriceUsd, "goldMark")
        : parseDecimal(tick.silverPriceUsd, "silverMark");
    const sideSign = leg.side === "long" ? 1 : -1;
    grossPnl += sideSign * (mark - entry) * qty;
    remainingNotional += qty * mark;
    if (leg.entryFeeUsd) {
      entryFees += parseDecimal(String(leg.entryFeeUsd), "fee");
    }
  }

  // Conservative exit-cost estimate: taker fees on the full remaining
  // notional of both legs (a limit close may do better; a market close
  // matches this exactly). makerFeeBps/takerFeeBps resolve at boot from
  // the live Arcus fee table when the env overrides are unset; when both
  // are absent (dry-run monitoring) the estimate is 0 by design.
  const takerBps = ctx.config.arcus.takerFeeBps ?? 0;
  const exitEstimate = (takerBps / 10_000) * remainingNotional;
  const breakeven = entryFees + exitEstimate;
  const net = grossPnl - breakeven;

  const marginUsd = parseDecimal(ctx.config.openTrade.marginUsd, "marginUsd");
  const totalMargin = 2 * marginUsd;
  const slThreshold =
    -(ctx.config.goldSilver.stopLossMarginPercent / 100) * totalMargin;
  const tpFloor =
    breakeven + parseDecimal(ctx.config.goldSilver.tpMinNetUsd, "tpMinNetUsd");

  // 1) Stop-loss: deepest priority, market close on both legs.
  if (net <= slThreshold) {
    console.warn("Metal trade SL trigger", {
      tradeId: trade.id,
      net,
      slThreshold,
    });
    ctx.enqueue({
      description: `metal-close:sl-${trade.id}`,
      run: () => closeMetalTrade(ctx, trade.id, "stop_loss", "market"),
    });
    return;
  }

  // 2) Take-profit: RSI crossed back to the OPPOSITE side (the entry
  // reason is exhausted) and the profit floor over breakeven is met.
  if (
    tick.crossed &&
    tick.side !== undefined &&
    tick.side !== trade.side &&
    net >= tpFloor
  ) {
    console.warn("Metal trade TP trigger", {
      tradeId: trade.id,
      net,
      tpFloor,
      side: tick.side,
    });
    ctx.enqueue({
      description: `metal-close:tp-${trade.id}`,
      run: () => closeMetalTrade(ctx, trade.id, "tp_rsi", "limit"),
    });
    return;
  }

  // 3) Time-stop: the floor stayed unmet for the whole window; exit at
  // market only when the trade is at/above breakeven.
  if (trade.openedAt) {
    const ageMs = Date.now() - trade.openedAt.getTime();
    if (
      ageMs >= ctx.config.goldSilver.timeStopHours * 3_600_000 &&
      net >= breakeven
    ) {
      console.warn("Metal trade time-stop trigger", {
        tradeId: trade.id,
        ageHours: ageMs / 3_600_000,
        net,
      });
      ctx.enqueue({
        description: `metal-close:timestop-${trade.id}`,
        run: () => closeMetalTrade(ctx, trade.id, "time_stop", "market"),
      });
    }
  }
}

/** Market symbol for a leg side, exposed for monitor/test reuse. */
export function metalLegMarketForSide(
  side: MetalRatioSide,
  legSide: "short" | "long",
): string {
  const { goldLeg } = metalLegMarkets(side);
  return legSide === goldLeg.side ? GOLD_MARKET : "SLV-USD";
}
