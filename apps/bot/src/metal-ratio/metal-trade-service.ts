import { and, eq, inArray } from "drizzle-orm";
import type { BotConfig } from "@btc-arbitrage/config";
import {
  GOLD_SILVER_SYMBOL,
  parseDecimal,
  formatDecimal,
  type MetalRatioSide,
} from "@btc-arbitrage/domain";
import {
  activeTradeStatuses,
  tradeLegs,
  trades,
  tradeStatusHistory,
  type getDb,
} from "@btc-arbitrage/db";
import type {
  ExecutionAdapter,
  ExecutionOrder,
} from "@btc-arbitrage/exchange-core";
import { sleep } from "@btc-arbitrage/shared";
import { extractAffectedRows, extractInsertId } from "../db-result.js";
import { GOLD_MARKET, SILVER_MARKET } from "./metal-ratio-warmup.js";

/** Dependencies for the gold/silver pair-trade service. The execution
 * adapter is the Arcus one (both legs live on Arcus — Arcus-only by
 * operator decision). */
export interface MetalTradeContext {
  db: Awaited<ReturnType<typeof getDb>>;
  config: BotConfig;
  execution: ExecutionAdapter;
  notify: (text: string) => Promise<void>;
  notifyUrgent: (text: string) => Promise<void>;
}

export interface MetalTradeRow {
  id: number;
  status: (typeof activeTradeStatuses)[number];
  side: MetalRatioSide;
  openedAt: Date | null;
}

/** One query for the active gold/silver trade (if any). Direction
 * derivation: legs are sized dollar-neutral, and the gold price is
 * always much higher than silver, so the gold leg's base quantity is
 * always the SMALLER of the two — the short leg being the smaller one
 * means short-gold/long-silver. */
export async function loadActiveMetalTrade(
  ctx: Pick<MetalTradeContext, "db">,
): Promise<MetalTradeRow | undefined> {
  const rows = await ctx.db
    .select({
      id: trades.id,
      status: trades.status,
      openedAt: trades.openedAt,
      legSide: tradeLegs.side,
      legQty: tradeLegs.quantityBase,
    })
    .from(trades)
    .innerJoin(tradeLegs, eq(tradeLegs.tradeId, trades.id))
    .where(
      and(
        eq(trades.symbol, GOLD_SILVER_SYMBOL),
        inArray(trades.status, [...activeTradeStatuses]),
      ),
    )
    .orderBy(trades.id)
    .limit(2);
  const first = rows[0];
  if (!first) return undefined;
  const shortQty = Number(
    rows.find((row) => row.legSide === "short")?.legQty ?? 0,
  );
  const longQty = Number(rows.find((row) => row.legSide === "long")?.legQty ?? 0);
  const side: MetalRatioSide =
    shortQty < longQty ? "short_gold_long_silver" : "long_gold_short_silver";
  return { id: first.id, status: first.status, side, openedAt: first.openedAt };
}

export function metalLegMarkets(side: MetalRatioSide): {
  goldLeg: { market: string; side: "short" | "long" };
  silverLeg: { market: string; side: "short" | "long" };
} {
  const goldSide: "short" | "long" =
    side === "short_gold_long_silver" ? "short" : "long";
  return {
    goldLeg: { market: GOLD_MARKET, side: goldSide },
    silverLeg: {
      market: SILVER_MARKET,
      side: goldSide === "short" ? "long" : "short",
    },
  };
}

function roundDownToStep(qty: number, step: number): number {
  if (!(step > 0)) return qty;
  return Math.floor(qty / step) * step;
}

function roundToTick(price: number, tick: number): number {
  if (!(tick > 0)) return price;
  return Math.round(price / tick) * tick;
}

async function insertStatusHistory(
  ctx: MetalTradeContext,
  row: {
    tradeId: number;
    fromStatus?: string;
    toStatus: string;
    reason: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await ctx.db.insert(tradeStatusHistory).values({
      tradeId: row.tradeId,
      fromStatus: row.fromStatus as never,
      toStatus: row.toStatus as never,
      reason: row.reason.slice(0, 512),
      metadata: row.metadata,
      changedAt: new Date(),
    });
  } catch (error) {
    // History is audit-only: never break the flow on it.
    console.warn("Metal trade status history insert failed", {
      tradeId: row.tradeId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Atomic status transition: the WHERE pins the expected from-status, so
 * concurrent triggers (SL vs TP race) resolve to exactly one owner. */
async function transitionTrade(
  ctx: MetalTradeContext,
  tradeId: number,
  fromStatus: string,
  toStatus: string,
  reason: string,
  extra: Record<string, unknown> = {},
  metadata?: Record<string, unknown>,
): Promise<boolean> {
  const result = await ctx.db
    .update(trades)
    .set(extra)
    .where(and(eq(trades.id, tradeId), eq(trades.status, fromStatus as never)));
  const changed = extractAffectedRows(result) > 0;
  if (changed) {
    await insertStatusHistory(ctx, {
      tradeId,
      fromStatus,
      toStatus,
      reason,
      metadata,
    });
  }
  return changed;
}

/** Creates the trade + legs rows for a gold/silver pair trade. Guards: no
 * other active metal trade, execution available. Since
 * gold-silver-decouple there is no active-pair requirement — the trade is
 * opened on demand from /ratio alongside the spread strategy.
 * Returns the trade id. */
export async function createMetalTrade(
  ctx: MetalTradeContext,
  side: MetalRatioSide,
): Promise<number> {
  const existing = await loadActiveMetalTrade(ctx);
  if (existing) {
    throw new Error(
      `A gold/silver trade is already active (trade #${existing.id}, ${existing.status})`,
    );
  }

  const [goldMeta, silverMeta, goldBbo, silverBbo] = await Promise.all([
    ctx.execution.getMarketMetadata({
      symbol: GOLD_MARKET,
      marketType: "perpetual",
      priceSource: "mark",
    }),
    ctx.execution.getMarketMetadata({
      symbol: SILVER_MARKET,
      marketType: "perpetual",
      priceSource: "mark",
    }),
    ctx.execution.getBestBidOffer({
      symbol: GOLD_MARKET,
      marketType: "perpetual",
      priceSource: "mark",
    }),
    ctx.execution.getBestBidOffer({
      symbol: SILVER_MARKET,
      marketType: "perpetual",
      priceSource: "mark",
    }),
  ]);
  const leverage = ctx.config.goldSilver.leverage;
  await Promise.all([
    ctx.execution.validateExecutionPreflight({
      symbol: GOLD_MARKET,
      leverage,
    }),
    ctx.execution.validateExecutionPreflight({
      symbol: SILVER_MARKET,
      leverage,
    }),
  ]);

  const marginUsd = parseDecimal(ctx.config.goldSilver.marginUsd, "marginUsd");
  const notionalUsd = marginUsd * leverage;
  const goldPrice = parseDecimal(goldBbo.askUsd, "goldAsk");
  const silverPrice = parseDecimal(silverBbo.askUsd, "silverAsk");
  const goldQty = roundDownToStep(
    notionalUsd / goldPrice,
    parseDecimal(goldMeta.quantityStepBase || "0.0001", "goldStep"),
  );
  const silverQty = roundDownToStep(
    notionalUsd / silverPrice,
    parseDecimal(silverMeta.quantityStepBase || "0.01", "silverStep"),
  );
  const minGold = parseDecimal(goldMeta.minQuantityBase || "0", "minGold");
  const minSilver = parseDecimal(silverMeta.minQuantityBase || "0", "minSilver");
  if (goldQty < Math.max(minGold, 1e-8) || silverQty < Math.max(minSilver, 1e-8)) {
    throw new Error(
      `Computed quantity below minimum (gold ${goldQty}, silver ${silverQty})`,
    );
  }

  const { goldLeg, silverLeg } = metalLegMarkets(side);
  const created = await ctx.db.transaction(async (tx) => {
    const tradeResult = await tx.insert(trades).values({
      symbol: GOLD_SILVER_SYMBOL,
      marketType: "perpetual",
      priceSource: "mark",
      mode: ctx.config.botExecutionMode,
      status: "executing_limit",
      longExchange: "arcus",
      shortExchange: "arcus",
      leverage,
      filledNotionalUsd: "0",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const tradeId = extractInsertId(tradeResult);
    if (tradeId === undefined || tradeId <= 0) {
      throw new Error("Failed to create metal trade row");
    }
    await tx.insert(tradeLegs).values([
      {
        tradeId,
        exchangeId: "arcus",
        side: goldLeg.side,
        status: "planned",
        quantityBase: formatDecimal(goldQty, 8),
        quantityUsd: formatDecimal(goldQty * goldPrice, 8),
        // The leg's market lives in raw: the pseudo-symbol GOLDSILVER is
        // not resolvable by any exchange, so the position monitor reads
        // the per-leg market from here.
        raw: { market: GOLD_MARKET },
      },
      {
        tradeId,
        exchangeId: "arcus",
        side: silverLeg.side,
        status: "planned",
        quantityBase: formatDecimal(silverQty, 8),
        quantityUsd: formatDecimal(silverQty * silverPrice, 8),
        raw: { market: SILVER_MARKET },
      },
    ]);
    return tradeId;
  });
  await insertStatusHistory(ctx, {
    tradeId: created,
    toStatus: "executing_limit",
    reason: `metal entry created (${side})`,
    metadata: { side, notionalUsd: formatDecimal(notionalUsd, 8) },
  });
  console.warn("Metal trade created", {
    tradeId: created,
    side,
    notionalUsd: formatDecimal(notionalUsd, 2),
    goldQty: formatDecimal(goldQty, 8),
    silverQty: formatDecimal(silverQty, 8),
  });
  return created;
}

interface LegProgress {
  legId: number;
  side: "short" | "long";
  targetQty: number;
  /** Cumulative GOLD base filled (drives the entry loop). */
  goldFilledQty: number;
  /** Cumulative SILVER base hedged (never equal to goldFilledQty —
   * converted by USD notional per fill increment). */
  silverFilledQty: number;
  /** Volume-weighted average silver entry price. */
  silverVwap: number;
  entryFeeUsd: number;
}

/** Exported for smoke-testing the post-only clamp boundaries. */
export function limitPriceForSide(
  side: "short" | "long",
  bbo: { bidUsd: string; askUsd: string },
  improveTicks: number,
  tickUsd: number,
): number {
  const bid = parseDecimal(bbo.bidUsd, "bid");
  const ask = parseDecimal(bbo.askUsd, "ask");
  const improve = improveTicks * tickUsd;
  // Post-only legality (Arcus ALO): a SELL crosses iff price <= bid, a BUY
  // crosses iff price >= ask. Improvement moves toward the touch but never
  // past the legal side of the book:
  //  sell: price in [bid + tick, ask] (join the ask queue when the
  //        improvement would sit at/under the bid)
  //  buy:  price in [bid, ask - tick] (join the bid queue likewise)
  // On a LOCKED book (bid == ask) the sell rests at bid + tick (a new ask
  // level, never crossing) and the buy rests at bid - tick. Trade #1317:
  // the old clamp (ask - tick ceiling for sells) produced a sell BELOW the
  // bid on locked books, so every attempt — including the join-best
  // fallback — crossed.
  if (side === "short") {
    const price = Math.min(bid + improve, ask);
    return roundToTick(Math.max(price, bid + tickUsd), tickUsd);
  }
  const price = Math.max(ask - improve, bid);
  return roundToTick(Math.min(price, ask - tickUsd), tickUsd);
}

function touchPriceForClose(
  side: "short" | "long",
  bbo: { bidUsd: string; askUsd: string },
  tickUsd: number,
): number {
  // Closing: short => buy back at the ask; long => sell at the bid.
  return side === "short"
    ? roundToTick(parseDecimal(bbo.askUsd, "ask"), tickUsd)
    : roundToTick(parseDecimal(bbo.bidUsd, "bid"), tickUsd);
}

function isPostOnlyRejection(message: string): boolean {
  return /POST_ONLY_WOULD_CROSS|post.only/i.test(message);
}

/** Defensive read of the disaster-stop order id persisted in the leg's
 * raw JSON (same `slOrderId` key the BTC position monitor uses). */
function readLegSlOrderId(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = (raw as Record<string, unknown>).slOrderId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Entry state machine: passive ALO limit on the GOLD leg, immediate
 * market hedge on the SILVER leg per filled increment, cancel-race on
 * timeout, emergency close on mid-way failure. Mirrors the BTC open-trade
 * contract (specs/bot.md) with single-venue pair semantics. Runs on the
 * serial execution queue. */
export async function executeMetalTradeEntry(
  ctx: MetalTradeContext,
  tradeId: number,
): Promise<void> {
  const trade = (
    await ctx.db.select().from(trades).where(eq(trades.id, tradeId)).limit(1)
  )[0];
  if (!trade || trade.status !== "executing_limit") return;
  const legRows = await ctx.db
    .select()
    .from(tradeLegs)
    .where(eq(tradeLegs.tradeId, tradeId));
  const side: MetalRatioSide = tradeSideFromLegs(
    legRows.map((leg) => ({ side: leg.side, qty: String(leg.quantityBase) })),
  );
  const { goldLeg, silverLeg } = metalLegMarkets(side);
  const goldRow = legRows.find((leg) => leg.side === goldLeg.side);
  const silverRow = legRows.find((leg) => leg.side === silverLeg.side);
  if (!goldRow || !silverRow) throw new Error("Metal trade legs missing");
  // Narrowed copies for the nested entry helpers (TS does not propagate
  // outer narrowing into hoisted function declarations).
  const goldLegRow = goldRow;
  const silverLegRow = silverRow;

  const goldMeta = await ctx.execution.getMarketMetadata({
    symbol: GOLD_MARKET,
    marketType: "perpetual",
    priceSource: "mark",
  });
  const silverMeta = await ctx.execution.getMarketMetadata({
    symbol: SILVER_MARKET,
    marketType: "perpetual",
    priceSource: "mark",
  });
  const silverStep = parseDecimal(
    silverMeta.quantityStepBase || "0.01",
    "silverStep",
  );
  const silverMin = parseDecimal(
    silverMeta.minQuantityBase || "0",
    "silverMin",
  );
  const tick = parseDecimal(goldMeta.priceTickUsd || "0.01", "tick");
  const improveTicks = ctx.config.goldSilver.entryImproveTicks;
  const pollMs = 250;
  const deadline = Date.now() + ctx.config.goldSilver.limitTimeoutMs;
  const repriceEvery = Math.max(
    ctx.config.goldSilver.limitRepriceIntervalMs,
    pollMs,
  );

  const progress: LegProgress = {
    legId: goldLegRow.id,
    side: goldLeg.side,
    targetQty: parseDecimal(String(goldLegRow.quantityBase), "goldQty"),
    goldFilledQty: 0,
    silverFilledQty: 0,
    silverVwap: 0,
    entryFeeUsd: 0,
  };

  let orderId: string | undefined;
  let lastRepriceAt = 0;
  let lastRepriceNotifyAt = 0;
  let postOnlyRetries = 0;
  let restingPrice = 0;
  let goldFillPrice = 0;

  const placeLimit = async (price: number): Promise<string> => {
    const order = await ctx.execution.submitExecutionOrder({
      clientOrderId: `mt${tradeId}g${Date.now().toString(36)}`,
      symbol: GOLD_MARKET,
      side: goldLeg.side === "short" ? "sell" : "buy",
      type: "limit",
      quantityBase: formatDecimal(
        progress.targetQty - progress.goldFilledQty,
        8,
      ),
      priceUsd: formatDecimal(price, 4),
    });
    restingPrice = price;
    return order.id;
  };

  try {
    // Initial placement: ALO rejects with POST_ONLY_WOULD_CROSS when the
    // improved price crosses the book (thin GLD book). The clamp in
    // limitPriceForSide makes a cross impossible at quote time, but the
    // book can move between quote and placement, so each retry re-reads
    // the BBO; after the retry budget, join the best price (improvement
    // 0), which is guaranteed post-only.
    for (let attempt = 0; ; attempt += 1) {
      const quoteBbo = await ctx.execution.getBestBidOffer({
        symbol: GOLD_MARKET,
        marketType: "perpetual",
        priceSource: "mark",
      });
      try {
        orderId = await placeLimit(
          limitPriceForSide(goldLeg.side, quoteBbo, improveTicks, tick),
        );
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isPostOnlyRejection(message) && attempt < 3) {
          continue;
        }
        if (isPostOnlyRejection(message)) {
          orderId = await placeLimit(
            limitPriceForSide(goldLeg.side, quoteBbo, 0, tick),
          );
          break;
        }
        throw error;
      }
    }
    await ctx.db
      .update(tradeLegs)
      .set({ status: "submitted", entryOrderId: orderId })
      .where(eq(tradeLegs.id, goldLegRow.id));
    await ctx
      .notify(
        `⏳ Trade #${tradeId}: limit ${goldLeg.side === "short" ? "SELL" : "BUY"} resting on GLD at $${formatDecimal(restingPrice, 2)} ` +
          `(${formatDecimal(progress.targetQty, 6)} GLD). Hedging each fill on SLV at market. ` +
          `Timeout in ${Math.round(ctx.config.goldSilver.limitTimeoutMs / 1000)}s.`,
      )
      // Guarded like every sibling notification in this flow: a Telegram
      // outage must never abort the fill-monitoring loop that owns the
      // resting exchange order (review finding R3-unguarded-entry-notify).
      .catch(() => undefined);

    while (Date.now() < deadline) {
      const order = await ctx.execution
        .getExecutionOrder(orderId)
        .catch(() => null);
      if (order) {
        const filled = parseDecimal(order.filledQuantityBase, "filled");
        const increment = filled - progress.goldFilledQty;
        if (increment > 1e-9 && order.status !== "cancelled") {
          const fillPrice = order.averageFillPriceUsd
            ? parseDecimal(order.averageFillPriceUsd, "goldFill")
            : restingPrice;
          await hedgeIncrement(increment, fillPrice);
          goldFillPrice = fillPrice;
        }
        if (
          order.status === "filled" ||
          progress.goldFilledQty >= progress.targetQty - 1e-9
        ) {
          await finishEntry(goldFillPrice || restingPrice);
          return;
        }
        if (order.status === "cancelled" || order.status === "rejected") {
          break;
        }
      }

      if (Date.now() - lastRepriceAt >= repriceEvery) {
        lastRepriceAt = Date.now();
        const freshBbo = await ctx.execution
          .getBestBidOffer({
            symbol: GOLD_MARKET,
            marketType: "perpetual",
            priceSource: "mark",
          })
          .catch(() => undefined);
        if (freshBbo) {
          const nextPrice = limitPriceForSide(
            goldLeg.side,
            freshBbo,
            improveTicks,
            tick,
          );
          if (nextPrice !== restingPrice) {
            await ctx.execution.cancelExecutionOrder(orderId).catch(() => undefined);
            try {
              orderId = await placeLimit(nextPrice);
              postOnlyRetries = 0;
              // Reprice feedback, throttled: one notice per 30 s so a slow
              // book does not spam the chat (the order state is the
              // source of truth; the ticker is informational).
              if (Date.now() - lastRepriceNotifyAt >= 30_000) {
                lastRepriceNotifyAt = Date.now();
                await ctx
                  .notify(
                    `🔁 Trade #${tradeId}: GLD limit not filled — repriced to $${formatDecimal(nextPrice, 2)} (resting).`,
                  )
                  .catch(() => undefined);
              }
            } catch (error) {
              if (
                isPostOnlyRejection(
                  error instanceof Error ? error.message : String(error),
                ) &&
                postOnlyRetries < 3
              ) {
                postOnlyRetries += 1;
                // Join the best instead of improving: guaranteed post-only.
                orderId = await placeLimit(
                  limitPriceForSide(goldLeg.side, freshBbo, 0, tick),
                );
              } else {
                throw error;
              }
            }
          }
        }
      }
      await sleep(pollMs);
    }

    // Timeout: cancel and race a possible late fill (max-filled wins).
    await ctx.execution.cancelExecutionOrder(orderId).catch(() => undefined);
    let finalOrder: ExecutionOrder | null = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await sleep(500);
      finalOrder = await ctx.execution
        .getExecutionOrder(orderId)
        .catch(() => null);
      if (
        finalOrder &&
        ["filled", "cancelled", "rejected"].includes(finalOrder.status)
      ) {
        break;
      }
    }
    if (finalOrder) {
      const filled = parseDecimal(finalOrder.filledQuantityBase, "filled");
      const increment = filled - progress.goldFilledQty;
      if (increment > 1e-9) {
        const fillPrice = finalOrder.averageFillPriceUsd
          ? parseDecimal(finalOrder.averageFillPriceUsd, "goldFill")
          : restingPrice;
        await hedgeIncrement(increment, fillPrice);
        goldFillPrice = fillPrice;
      }
      if (
        finalOrder.status === "filled" ||
        progress.goldFilledQty >= progress.targetQty - 1e-9
      ) {
        await finishEntry(goldFillPrice || restingPrice);
        return;
      }
    }
    await abortEntry("limit timeout without fill");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Metal trade entry failed", { tradeId, message });
    await abortEntry(message);
  }

  async function hedgeIncrement(
    incrementGoldQty: number,
    goldPriceUsd: number,
  ): Promise<void> {
    // Convert the gold fill into SILVER units by USD notional (trade
    // #1317: hedging the raw gold quantity 1:1 left the pair massively
    // unbalanced — 0.1358 GLD ≠ 0.1358 SLV in dollars).
    const silverBbo = await ctx.execution.getBestBidOffer({
      symbol: SILVER_MARKET,
      marketType: "perpetual",
      priceSource: "mark",
    });
    const silverRef =
      silverLeg.side === "long"
        ? parseDecimal(silverBbo.askUsd, "silverAsk")
        : parseDecimal(silverBbo.bidUsd, "silverBid");
    const silverQty = roundDownToStep(
      (incrementGoldQty * goldPriceUsd) / silverRef,
      silverStep,
    );
    if (silverQty < Math.max(silverMin, 1e-9)) {
      throw new Error(
        `Hedge increment below SLV minimum (${silverQty} < ${silverMin})`,
      );
    }
    const hedge = await ctx.execution.submitExecutionOrder({
      clientOrderId: `mt${tradeId}s${Date.now().toString(36)}`,
      symbol: SILVER_MARKET,
      side: silverLeg.side === "short" ? "sell" : "buy",
      type: "market",
      quantityBase: formatDecimal(silverQty, 8),
    });
    // The fill price MUST be real: a single immediate read races Arcus's
    // async fill reporting (trade #1320: averageFillPriceUsd was absent,
    // the leg entry was recorded as $0.00, and the disaster stop computed
    // an invalid $0 trigger — rejected by the exchange). Poll until the
    // order reports a filled average price; abort the entry if it never
    // does (a corrupt entry price poisons VWAP, PnL triggers, and stops).
    const confirmed = await pollFilledOrder(ctx, hedge.id);
    const fillPrice = parseDecimal(
      confirmed.averageFillPriceUsd ?? "0",
      "hedgeFill",
    );
    if (!(fillPrice > 0)) {
      throw new Error(
        `Hedge order ${hedge.id} filled without an average price`,
      );
    }
    const fee = confirmed.feeUsd ? parseDecimal(confirmed.feeUsd, "fee") : 0;
    const prevFee = silverLegRow.entryFeeUsd
      ? parseDecimal(String(silverLegRow.entryFeeUsd), "fee0")
      : 0;
    silverLegRow.entryFeeUsd = formatDecimal(prevFee + fee, 8);
    // Volume-weighted average silver entry price.
    const prevQty = progress.silverFilledQty;
    progress.silverVwap =
      prevQty + silverQty > 0
        ? (prevQty * progress.silverVwap + silverQty * fillPrice) /
          (prevQty + silverQty)
        : fillPrice;
    progress.silverFilledQty += silverQty;
    progress.goldFilledQty += incrementGoldQty;
    progress.entryFeeUsd += fee;
    await ctx
      .notify(
        `⚖️ Trade #${tradeId} hedge: +${formatDecimal(incrementGoldQty, 6)} GLD @ $${formatDecimal(goldPriceUsd, 2)} → ${silverLeg.side === "short" ? "sold" : "bought"} ${formatDecimal(silverQty, 4)} SLV @ $${formatDecimal(fillPrice, 2)} (fee $${formatDecimal(fee, 4)}). ` +
          `Gold leg ${formatDecimal(progress.goldFilledQty, 6)}/${formatDecimal(progress.targetQty, 6)} filled.`,
      )
      .catch(() => undefined);
    await ctx.db
      .update(tradeLegs)
      .set({
        status: "open",
        entryPriceUsd: formatDecimal(progress.silverVwap, 8),
        quantityBase: formatDecimal(progress.silverFilledQty, 8),
        entryFeeUsd: silverLegRow.entryFeeUsd,
        filledNotionalUsd: formatDecimal(
          progress.silverFilledQty * progress.silverVwap,
          8,
        ),
        openedAt: new Date(),
      })
      .where(eq(tradeLegs.id, silverLegRow.id));
  }

  /** Exchange-resting disaster stops (stop-market reduce-only) on both
   * legs, anchored to each leg's own fill at a price distance of
   * GOLDSILVER_STOP_LOSS_MARGIN_PERCENT / leverage. These are bot-down
   * insurance ONLY: the strategy SL/TP are computed on the pair's NET PnL
   * and stay bot-driven (a leg-level stop at the pair's SL threshold would
   * fire on normal divergence). The stop order id is persisted in the
   * leg's raw JSON (same `slOrderId` contract the position monitor uses),
   * so an exchange-side fire is detected, finalizes the leg, and flips
   * the trade to unhedged with an urgent notice. A placement failure
   * degrades to an urgent notice — the entry itself already succeeded. */
  async function placeDisasterStops(goldEntryPrice: number): Promise<void> {
    const fraction =
      ctx.config.goldSilver.stopLossMarginPercent /
      100 /
      ctx.config.goldSilver.leverage;
    const legPlans = [
      {
        row: goldLegRow,
        side: goldLeg.side,
        market: GOLD_MARKET,
        qty: progress.goldFilledQty,
        entry: goldEntryPrice,
      },
      {
        row: silverLegRow,
        side: silverLeg.side,
        market: SILVER_MARKET,
        qty: progress.silverFilledQty,
        entry: progress.silverVwap,
      },
    ];
    for (const plan of legPlans) {
      if (plan.qty <= 1e-9 || !(plan.entry > 0)) continue;
      const trigger =
        plan.side === "short"
          ? plan.entry * (1 + fraction)
          : plan.entry * (1 - fraction);
      // Place AND verify: Arcus acknowledges placement asynchronously (202
      // = received, not resting) — a stop rejected after the ACK is
      // invisible unless we read the order back (the silver SL of the
      // first disaster-stop trade silently never rested). "Resting" for a
      // stop = new/open/untriggered; rejected/cancelled means placement
      // failed. One retry covers transient races; persistent failure is
      // surfaced loud with whatever the exchange told us.
      const restingStates = new Set(["new", "open", "untriggered"]);
      const placeAndVerify = async (): Promise<
        { failure?: string; orderId?: string }
      > => {
        try {
          const order = await ctx.execution.submitExecutionOrder({
            clientOrderId: `mt${tradeId}sl${plan.row.id}`,
            symbol: plan.market,
            side: plan.side === "short" ? "buy" : "sell",
            type: "stop-market",
            quantityBase: formatDecimal(plan.qty, 8),
            triggerPriceUsd: formatDecimal(trigger, 4),
            reduceOnly: true,
          });
          for (let attempt = 0; attempt < 3; attempt += 1) {
            await sleep(2_000);
            const state = await ctx.execution
              .getExecutionOrder(order.id)
              .catch(() => null);
            if (!state) continue;
            if (restingStates.has(state.status)) return { orderId: order.id };
            if (state.status === "rejected" || state.status === "cancelled") {
              return { failure: `order ${order.id} ended ${state.status}` };
            }
          }
          // Still pending after ~6 s: treat as resting (Arcus ACK latency).
          return { orderId: order.id };
        } catch (error) {
          return {
            failure: error instanceof Error ? error.message : String(error),
          };
        }
      };
      let result = await placeAndVerify();
      if (result.failure) result = await placeAndVerify();
      if (result.failure || !result.orderId) {
        const failure = result.failure ?? "unknown placement failure";
        console.error("Metal trade disaster stop placement failed", {
          tradeId,
          legId: plan.row.id,
          market: plan.market,
          message: failure,
        });
        await ctx.notifyUrgent(
          `🚨 Gold/silver trade #${tradeId}: DISASTER STOP MISSING on ${plan.market} (${failure}). ` +
            "The leg has NO exchange-resting protection; the bot-driven SL still applies while the bot is alive. " +
            "Check Arcus order history for the rejection reason and consider a manual stop.",
        );
        continue;
      }
      const existing =
        plan.row.raw &&
        typeof plan.row.raw === "object" &&
        !Array.isArray(plan.row.raw)
          ? (plan.row.raw as Record<string, unknown>)
          : {};
      await ctx.db
        .update(tradeLegs)
        .set({ raw: { ...existing, slOrderId: result.orderId } })
        .where(eq(tradeLegs.id, plan.row.id));
    }
  }

  async function finishEntry(goldEntryPrice: number): Promise<void> {
    await ctx.db
      .update(tradeLegs)
      .set({
        status: "open",
        entryPriceUsd: formatDecimal(goldEntryPrice, 8),
        quantityBase: formatDecimal(progress.goldFilledQty, 8),
        filledNotionalUsd: formatDecimal(
          progress.goldFilledQty * goldEntryPrice,
          8,
        ),
        openedAt: new Date(),
      })
      .where(eq(tradeLegs.id, goldLegRow.id));
    await placeDisasterStops(goldEntryPrice);
    await transitionTrade(
      ctx,
      tradeId,
      "executing_limit",
      "open",
      "metal entry complete",
      { status: "open", openedAt: new Date() },
    );
    await ctx.notify(
      `🥇🥈 Gold/silver trade #${tradeId} OPEN ` +
        `(${side === "short_gold_long_silver" ? "SHORT GOLD / LONG SILVER" : "LONG GOLD / SHORT SILVER"}).\n` +
        `Legs filled on Arcus. TP: RSI return to 50 with net >= breakeven + $${ctx.config.goldSilver.tpMinNetUsd}. ` +
        `SL: -${ctx.config.goldSilver.stopLossMarginPercent}% margin (market).`,
    );
  }

  async function abortEntry(reason: string): Promise<void> {
    // Verified emergency closes on BOTH covered legs. Trade #1319: the
    // old fire-and-forget close left live positions on Arcus after the
    // trade was marked failed (Arcus order placement is async — a 202 ACK
    // is not a fill), and the gold leg was never closed at all.
    // Cancel the resting gold limit first, then close each covered leg
    // and VERIFY the close order reached a terminal state.
    if (orderId) {
      await ctx.execution.cancelExecutionOrder(orderId).catch(() => undefined);
    }
    const failures: string[] = [];
    const closeJobs = [
      {
        market: SILVER_MARKET,
        side: silverLeg.side,
        qty: progress.silverFilledQty,
      },
      {
        market: GOLD_MARKET,
        side: goldLeg.side,
        qty: progress.goldFilledQty,
      },
    ];
    for (const job of closeJobs) {
      if (job.qty <= 1e-9) continue;
      try {
        const order = await ctx.execution.submitExecutionOrder({
          clientOrderId: `mt${tradeId}er${job.market === GOLD_MARKET ? "g" : "s"}${Date.now().toString(36)}`,
          symbol: job.market,
          side: job.side === "short" ? "buy" : "sell",
          type: "market",
          quantityBase: formatDecimal(job.qty, 8),
          reduceOnly: true,
        });
        const terminal = await pollOrderTerminal(ctx, order.id);
        if (terminal.status !== "filled") {
          failures.push(`${job.market}: close order ended ${terminal.status}`);
        }
      } catch (error) {
        failures.push(
          `${job.market}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    // ALL legs are cancelled on a failed entry — the hedge leg is 'open'
    // by abort time and must not linger as a phantom open leg (trade
    // #1319's DB/exchange mismatch).
    await ctx.db
      .update(tradeLegs)
      .set({ status: "cancelled" })
      .where(eq(tradeLegs.tradeId, tradeId));
    await transitionTrade(
      ctx,
      tradeId,
      "executing_limit",
      "failed",
      `metal entry aborted: ${reason}`,
      { status: "failed", closedAt: new Date() },
    );
    const coveredNote =
      progress.silverFilledQty > 1e-9 || progress.goldFilledQty > 1e-9
        ? ` Covered quantity was market-closed (SLV ${formatDecimal(progress.silverFilledQty, 4)}, GLD ${formatDecimal(progress.goldFilledQty, 6)}).`
        : "";
    await ctx.notifyUrgent(
      `🥇🥈 Gold/silver trade #${tradeId} FAILED at entry: ${reason}.${coveredNote}` +
        (failures.length > 0
          ? `\n🚨 UNVERIFIED CLOSES — POSITIONS MAY STILL BE OPEN ON ARCUS: ${failures.join("; ")}. MANUAL ACTION REQUIRED.`
          : ""),
    );
  }
}

interface CloseLeg {
  id: number;
  side: "short" | "long";
  market: string;
  quantityBase: string | null;
}

interface LegExit {
  legId: number;
  exitPrice: number;
  exitFeeUsd: number;
  qty: number;
}

/** Closes an open metal trade. mode "market" (SL / time-stop / the
 * operator's manual "Close @ market" escape hatch): immediate market
 * reduce-only on both legs. mode "limit" (TP): paired dual-limit close
 * — reduce-only limits resting at the touch; when one leg fills, the
 * other is repriced every exitRepriceIntervalMs; the first exhausted
 * budget (slippage bps / max wait / max reprices) market-closes the
 * remainder. The claim accepts "unhedged" too: one leg may already be
 * closed, the close finishes the remaining open legs. */
export async function closeMetalTrade(
  ctx: MetalTradeContext,
  tradeId: number,
  reason: string,
  mode: "limit" | "market",
): Promise<void> {
  const current = (
    await ctx.db
      .select({ status: trades.status })
      .from(trades)
      .where(eq(trades.id, tradeId))
      .limit(1)
  )[0];
  if (!current || (current.status !== "open" && current.status !== "unhedged")) {
    return; // not closeable (already closing/closed, or still entering).
  }
  const claimed = await transitionTrade(
    ctx,
    tradeId,
    current.status,
    "closing",
    `close requested: ${reason} (${mode})`,
    { status: "closing" },
  );
  if (!claimed) return; // SL-vs-TP race: exactly one owner wins.
  await ctx
    .notify(
      `⏳ Closing gold/silver trade #${tradeId} (${reason}, mode: ${mode}). ` +
        (mode === "limit"
          ? "Dual limits resting on both legs; the unfilled leg reprices toward the book and falls back to market if the budget is exhausted."
          : "Market close on both legs."),
    )
    .catch(() => undefined);

  try {
    const trade = (
      await ctx.db.select().from(trades).where(eq(trades.id, tradeId)).limit(1)
    )[0];
    if (!trade) return;
    const legRowsForCancel = await ctx.db
      .select()
      .from(tradeLegs)
      .where(eq(tradeLegs.tradeId, tradeId));
    // Cancel the resting disaster stops BEFORE the paired close: they are
    // reduce-only (inert on a flat position), but a leftover trigger on a
    // closed trade would rest forever. Failures degrade to a warning —
    // never block the close on a cancellation.
    for (const leg of legRowsForCancel) {
      const slOrderId = readLegSlOrderId(leg.raw);
      if (!slOrderId) continue;
      await ctx.execution.cancelExecutionOrder(slOrderId).catch((error: unknown) => {
        console.warn("Metal trade disaster stop cancel failed", {
          tradeId,
          legId: leg.id,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
    const side: MetalRatioSide = tradeSideFromLegs(
      (
        await ctx.db
          .select({ side: tradeLegs.side, qty: tradeLegs.quantityBase })
          .from(tradeLegs)
          .where(eq(tradeLegs.tradeId, tradeId))
      ).map((leg) => ({ side: leg.side, qty: String(leg.qty ?? "0") })),
    );
    const { goldLeg } = metalLegMarkets(side);
    const legRows = await ctx.db
      .select()
      .from(tradeLegs)
      .where(eq(tradeLegs.tradeId, tradeId));
    const openLegs: CloseLeg[] = legRows
      .filter((leg) => leg.status === "open")
      .map((leg) => ({
        id: leg.id,
        side: leg.side as "short" | "long",
        market: leg.side === goldLeg.side ? GOLD_MARKET : SILVER_MARKET,
        quantityBase: leg.quantityBase ? String(leg.quantityBase) : null,
      }));
    if (openLegs.length === 0) {
      await finalizeClosedTrade(ctx, tradeId, reason, []);
      return;
    }

    const exits: LegExit[] = [];

    if (mode === "market") {
      for (const leg of openLegs) {
        const qty = parseDecimal(leg.quantityBase ?? "0", "legQty");
        if (qty <= 1e-9) continue;
        // Close direction: short => buy back, long => sell (same mapping
        // as the disaster stops, the emergency rollback, and the limit
        // close below — NOT the entry direction).
        const closeSide = leg.side === "short" ? "buy" : "sell";
        const order = await ctx.execution.submitExecutionOrder({
          clientOrderId: `mt${tradeId}c${leg.id}${Date.now().toString(36)}`,
          symbol: leg.market,
          side: closeSide,
          type: "market",
          quantityBase: formatDecimal(qty, 8),
          reduceOnly: true,
        });
        const confirmed = await pollOrderTerminal(ctx, order.id);
        exits.push({
          legId: leg.id,
          exitPrice: parseDecimal(confirmed.averageFillPriceUsd ?? "0", "exit"),
          exitFeeUsd: confirmed.feeUsd
            ? parseDecimal(confirmed.feeUsd, "fee")
            : 0,
          qty,
        });
      }
      await finalizeClosedTrade(ctx, tradeId, reason, exits);
      return;
    }

    // Paired dual-limit close.
    const metaByMarket = new Map(
      await Promise.all(
        [...new Set(openLegs.map((leg) => leg.market))].map(
          async (market) =>
            [
              market,
              await ctx.execution.getMarketMetadata({
                symbol: market,
                marketType: "perpetual",
                priceSource: "mark",
              }),
            ] as const,
        ),
      ),
    );

    const orders = new Map<number, string>();
    for (const leg of openLegs) {
      const meta = metaByMarket.get(leg.market);
      const tick = parseDecimal(meta?.priceTickUsd || "0.01", "tick");
      const qty = parseDecimal(leg.quantityBase ?? "0", "legQty");
      if (qty <= 1e-9) continue;
      const bbo = await ctx.execution.getBestBidOffer({
        symbol: leg.market,
        marketType: "perpetual",
        priceSource: "mark",
      });
      // reduce-only limits rest as GTT at the touch (the Arcus adapter
      // maps reduce-only => GTT); priced AT the bid/ask so they rest
      // maker rather than cross.
      const price = touchPriceForClose(leg.side, bbo, tick);
      const order = await ctx.execution.submitExecutionOrder({
        clientOrderId: `mt${tradeId}x${leg.id}${Date.now().toString(36)}`,
        symbol: leg.market,
        side: leg.side === "short" ? "buy" : "sell",
        type: "limit",
        quantityBase: formatDecimal(qty, 8),
        priceUsd: formatDecimal(price, 4),
        reduceOnly: true,
      });
      orders.set(leg.id, order.id);
    }

    const startedAt = Date.now();
    let reprices = 0;
    let baselinePrice = 0;
    const lastRepriceAtByLeg = new Map<number, number>();
    let remaining = new Set(orders.keys());

    while (remaining.size > 0) {
      for (const legId of [...remaining]) {
        const leg = openLegs.find((row) => row.id === legId);
        const orderId = orders.get(legId);
        if (!leg || !orderId) {
          remaining.delete(legId);
          continue;
        }
        const order = await ctx.execution
          .getExecutionOrder(orderId)
          .catch(() => null);
        if (!order) continue;

        if (order.status === "filled") {
          const exitPrice = parseDecimal(
            order.averageFillPriceUsd ?? "0",
            "exit",
          );
          exits.push({
            legId,
            exitPrice,
            exitFeeUsd: order.feeUsd ? parseDecimal(order.feeUsd, "fee") : 0,
            qty: parseDecimal(leg.quantityBase ?? "0", "legQty"),
          });
          if (baselinePrice === 0) baselinePrice = exitPrice;
          remaining.delete(legId);
          await ctx
            .notify(
              `✅ Trade #${tradeId} close: ${leg.market} leg filled at $${formatDecimal(exitPrice, 2)}${remaining.size > 0 ? " — managing the other leg now" : ""}.`,
            )
            .catch(() => undefined);
          continue;
        }
        if (order.status === "cancelled" || order.status === "rejected") {
          remaining.delete(legId);
          const qtyLeft =
            parseDecimal(leg.quantityBase ?? "0", "legQty") -
            parseDecimal(order.filledQuantityBase, "filled");
          if (qtyLeft > 1e-9) {
            const marketOrder = await marketRemainder(ctx, tradeId, leg, qtyLeft);
            exits.push({
              legId,
              exitPrice: parseDecimal(
                marketOrder.averageFillPriceUsd ?? "0",
                "exit",
              ),
              exitFeeUsd: marketOrder.feeUsd
                ? parseDecimal(marketOrder.feeUsd, "fee")
                : 0,
              qty: parseDecimal(leg.quantityBase ?? "0", "legQty"),
            });
            if (baselinePrice === 0) {
              baselinePrice = exits[exits.length - 1].exitPrice;
            }
          }
        }
      }

      if (remaining.size === 1 && baselinePrice > 0) {
        const legId = [...remaining][0];
        const leg = openLegs.find((row) => row.id === legId)!;
        const orderId = orders.get(legId)!;
        const order = await ctx.execution
          .getExecutionOrder(orderId)
          .catch(() => null);
        const filledNow = order
          ? parseDecimal(order.filledQuantityBase, "filled")
          : 0;
        const qtyLeft =
          parseDecimal(leg.quantityBase ?? "0", "legQty") - filledNow;
        if (qtyLeft <= 1e-9) {
          remaining.delete(legId);
          continue;
        }

        const waited = Date.now() - startedAt;
        const budgetExhausted =
          waited >= ctx.config.goldSilver.exitMaxWaitMs ||
          reprices >= ctx.config.goldSilver.exitMaxReprices ||
          slippageConsumedBps(leg.side, baselinePrice, order) >=
            ctx.config.goldSilver.exitSlippageBudgetBps;
        if (budgetExhausted) {
          await ctx
            .notify(
              `⚠️ Trade #${tradeId} close: ${leg.market} limit exhausted the budget (${ctx.config.goldSilver.exitSlippageBudgetBps}bps / ${Math.round(ctx.config.goldSilver.exitMaxWaitMs / 1000)}s / ${ctx.config.goldSilver.exitMaxReprices} reprices) — closing the remainder at MARKET.`,
            )
            .catch(() => undefined);
          const marketOrder = await marketRemainder(ctx, tradeId, leg, qtyLeft);
          exits.push({
            legId,
            exitPrice: parseDecimal(
              marketOrder.averageFillPriceUsd ?? "0",
              "exit",
            ),
            exitFeeUsd: marketOrder.feeUsd
              ? parseDecimal(marketOrder.feeUsd, "fee")
              : 0,
            qty: parseDecimal(leg.quantityBase ?? "0", "legQty"),
          });
          remaining.delete(legId);
          continue;
        }

        const sinceReprice =
          Date.now() - (lastRepriceAtByLeg.get(legId) ?? startedAt);
        if (sinceReprice >= ctx.config.goldSilver.exitRepriceIntervalMs) {
          lastRepriceAtByLeg.set(legId, Date.now());
          reprices += 1;
          const meta = metaByMarket.get(leg.market);
          const tick = parseDecimal(meta?.priceTickUsd || "0.01", "tick");
          const bbo = await ctx.execution.getBestBidOffer({
            symbol: leg.market,
            marketType: "perpetual",
            priceSource: "mark",
          });
          const price = touchPriceForClose(leg.side, bbo, tick);
          await ctx.execution
            .cancelExecutionOrder(orderId)
            .catch(() => undefined);
          const replacement = await ctx.execution.submitExecutionOrder({
            clientOrderId: `mt${tradeId}r${leg.id}${Date.now().toString(36)}`,
            symbol: leg.market,
            side: leg.side === "short" ? "buy" : "sell",
            type: "limit",
            quantityBase: formatDecimal(qtyLeft, 8),
            priceUsd: formatDecimal(price, 4),
            reduceOnly: true,
          });
          orders.set(legId, replacement.id);
        }
      }
      if (remaining.size > 0) await sleep(1000);
    }

    await finalizeClosedTrade(ctx, tradeId, reason, exits);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Metal trade close failed", { tradeId, reason, message });
    await ctx.notifyUrgent(
      `🥇🥈 Gold/silver trade #${tradeId} CLOSE FAILED (${reason}): ${message}. ` +
        "Position may still be open on Arcus — check the exchange.",
    );
    // Leave status 'closing': the stale-closing recovery sweep owns it now.
  }
}

/** Exactly one leg is short. Legs are dollar-neutral, and gold's price is
 * always much higher than silver's, so the gold leg always has the
 * SMALLER base quantity — the short leg being the smaller one means
 * short-gold/long-silver. */
function tradeSideFromLegs(
  legs: Array<{ side: string; qty: string }>,
): MetalRatioSide {
  const shortQty = Number(legs.find((leg) => leg.side === "short")?.qty ?? 0);
  const longQty = Number(legs.find((leg) => leg.side === "long")?.qty ?? 0);
  return shortQty < longQty
    ? "short_gold_long_silver"
    : "long_gold_short_silver";
}

/** Deterioration of the unfilled leg's exit relative to the sibling fill
 * (bps): closing a short (buy back) deteriorates when the price rises;
 * closing a long (sell) deteriorates when the price falls. */
function slippageConsumedBps(
  legSide: "short" | "long",
  baselinePrice: number,
  order: ExecutionOrder | null,
): number {
  if (!(baselinePrice > 0) || !order) return 0;
  const reference = order.averageFillPriceUsd
    ? parseDecimal(order.averageFillPriceUsd, "px")
    : parseDecimal(
        order.status === "partially_filled"
          ? order.averageFillPriceUsd ?? String(baselinePrice)
          : String(baselinePrice),
        "px",
      );
  const worse =
    legSide === "short" ? reference - baselinePrice : baselinePrice - reference;
  return Math.max(0, (worse / baselinePrice) * 10_000);
}

/** Poll an order until it reports FILLED with an average fill price.
 * Arcus fills report asynchronously; a single read can precede the fill
 * data. Bounded: ~15 s, then throws (the caller aborts the entry with
 * verified closes rather than recording a corrupt price). */
async function pollFilledOrder(
  ctx: MetalTradeContext,
  orderId: string,
): Promise<ExecutionOrder> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const order = await ctx.execution
      .getExecutionOrder(orderId)
      .catch(() => null);
    if (order) {
      if (order.status === "filled" && order.averageFillPriceUsd) {
        return order;
      }
      if (order.status === "cancelled" || order.status === "rejected") {
        throw new Error(`Hedge order ${orderId} ended ${order.status}`);
      }
    }
    await sleep(500);
  }
  throw new Error(`Hedge order ${orderId} did not report a fill in time`);
}

async function marketRemainder(
  ctx: MetalTradeContext,
  tradeId: number,
  leg: CloseLeg,
  qtyLeft: number,
): Promise<ExecutionOrder> {
  const order = await ctx.execution.submitExecutionOrder({
    clientOrderId: `mt${tradeId}m${leg.id}${Date.now().toString(36)}`,
    symbol: leg.market,
    side: leg.side === "short" ? "buy" : "sell",
    type: "market",
    quantityBase: formatDecimal(qtyLeft, 8),
    reduceOnly: true,
  });
  return pollOrderTerminal(ctx, order.id);
}

async function pollOrderTerminal(
  ctx: MetalTradeContext,
  orderId: string,
): Promise<ExecutionOrder> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const order = await ctx.execution
      .getExecutionOrder(orderId)
      .catch(() => null);
    if (order && ["filled", "cancelled", "rejected"].includes(order.status)) {
      return order;
    }
    await sleep(1000);
  }
  throw new Error(`Order ${orderId} did not reach terminal state in time`);
}

async function finalizeClosedTrade(
  ctx: MetalTradeContext,
  tradeId: number,
  reason: string,
  exits: LegExit[],
): Promise<void> {
  const legRows = await ctx.db
    .select()
    .from(tradeLegs)
    .where(eq(tradeLegs.tradeId, tradeId));
  let grossPnl = 0;
  let totalFees = 0;
  let filledNotional = 0;
  for (const leg of legRows) {
    const exit = exits.find((row) => row.legId === leg.id);
    const entry = leg.entryPriceUsd
      ? parseDecimal(String(leg.entryPriceUsd), "entry")
      : 0;
    const qty = leg.quantityBase ? parseDecimal(String(leg.quantityBase), "qty") : 0;
    const sideSign = leg.side === "long" ? 1 : -1;
    const entryFee = leg.entryFeeUsd
      ? parseDecimal(String(leg.entryFeeUsd), "fee")
      : 0;
    const exitFee = exit?.exitFeeUsd ?? 0;
    const legPnl = exit ? sideSign * (exit.exitPrice - entry) * qty : 0;
    grossPnl += legPnl;
    totalFees += entryFee + exitFee;
    filledNotional += qty * entry;
    await ctx.db
      .update(tradeLegs)
      .set({
        status: exit ? "closed" : "failed",
        exitPriceUsd: exit ? formatDecimal(exit.exitPrice, 8) : null,
        exitFeeUsd: formatDecimal(exitFee, 8),
        realizedPnlUsd: formatDecimal(legPnl, 8),
        closeReason: reason.slice(0, 32),
        closedAt: new Date(),
      })
      .where(eq(tradeLegs.id, leg.id));
  }
  await transitionTrade(
    ctx,
    tradeId,
    "closing",
    "closed",
    `metal trade closed: ${reason}`,
    {
      status: "closed",
      closedAt: new Date(),
      realizedPnlUsd: formatDecimal(grossPnl, 8),
      totalFeesUsd: formatDecimal(totalFees, 8),
      filledNotionalUsd: formatDecimal(filledNotional, 8),
    },
  );
  const net = grossPnl - totalFees;
  await ctx.notify(
    `🥇🥈 Gold/silver trade #${tradeId} CLOSED (${reason}).\n` +
      `Gross PnL: $${formatDecimal(grossPnl, 2)} · Fees: $${formatDecimal(totalFees, 2)} · Net: $${formatDecimal(net, 2)}`,
  );
}
