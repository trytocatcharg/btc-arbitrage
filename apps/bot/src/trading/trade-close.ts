import { formatDecimal, parseDecimal } from "@btc-arbitrage/domain";
import type { ExchangeAdapter } from "@btc-arbitrage/exchange-core";
import type { PreviewStore, TradeLegUpdate } from "./open-trade.js";

/** Why the bot is closing an open (or just-filled) trade itself, instead of
 * waiting for the venue-side TP/SL backstop or the position monitor. */
export type SpreadCloseReason =
  | "spread_tp"
  | "spread_sl"
  | "spread_timeout"
  | "edge_below_cost"
  | "close_recovery";

export interface CloseLegInput {
  exchangeId: string;
  side: "long" | "short";
  quantityBase: string;
  entryPriceUsd: string | null;
  /** Leg raw JSON as persisted on trade_legs (tpOrderId/slOrderId when the
   * venue TP/SL backstop was placed). */
  raw: unknown;
}

export interface CloseTradeBothLegsInput {
  store: PreviewStore;
  registry: { get(id: string): ExchangeAdapter };
  token: string;
  /** Human label for notifications, e.g. "#35". Defaults to token prefix. */
  label?: string;
  symbol: string;
  longExchange: string;
  shortExchange: string;
  legs: CloseLegInput[];
  reason: SpreadCloseReason;
  notify: (text: string) => Promise<void>;
  /** Live spread (long price − short price) at the moment of the decision,
   * persisted as trades.exit_spread_usd. */
  exitSpreadUsd?: string;
  /** Filled quantity when it differs from the planned per-leg quantity
   * (partial limit fill before close). */
  quantityBaseOverride?: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const CLOSE_FLAT_TIMEOUT_MS = 10_000;
const CLOSE_FLAT_POLL_MS = 500;

/** Bot-initiated close of both legs: cancels the venue TP/SL backstop orders,
 * submits reduce-only market closes, waits for flat, then persists leg/trade
 * closure (with realized PnL when exit prices are known) through the preview
 * store so status history is recorded. A leg that cannot be confirmed flat
 * stays 'unhedged' so the position monitor keeps watching it. */
export async function closeTradeBothLegs(
  input: CloseTradeBothLegsInput,
): Promise<{ realizedPnlUsd: string | null }> {
  const now = input.now ?? (() => new Date());
  const sleep =
    input.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const label = input.label ?? input.token.slice(0, 8);
  const quantityBase =
    input.quantityBaseOverride ?? input.legs[0]?.quantityBase;
  if (!quantityBase) throw new Error("closeTradeBothLegs requires a quantity");
  const outcomes: string[] = [];

  // 1. Cancel the venue TP/SL backstop orders; a triggered order simply
  //    rejects the cancel and is reported as failed.
  for (const leg of input.legs) {
    const adapter = input.registry.get(leg.exchangeId).execution;
    if (!adapter) {
      outcomes.push(`${leg.exchangeId}: no execution adapter`);
      continue;
    }
    const raw = (leg.raw ?? {}) as { tpOrderId?: string; slOrderId?: string };
    for (const [kind, id] of [
      ["tp", raw.tpOrderId],
      ["sl", raw.slOrderId],
    ] as const) {
      if (!id) continue;
      try {
        await adapter.cancelExecutionOrder(id);
        outcomes.push(`${leg.exchangeId} ${kind} ${id} cancelled`);
      } catch {
        outcomes.push(`${leg.exchangeId} ${kind} ${id} cancel failed`);
      }
    }
  }

  // 2. Reduce-only market close per leg.
  const closes: Array<{
    leg: CloseLegInput;
    orderId?: string;
    averageFillPriceUsd?: string;
    error?: string;
  }> = [];
  for (const leg of input.legs) {
    const adapter = input.registry.get(leg.exchangeId).execution;
    if (!adapter) {
      closes.push({ leg, error: "no execution adapter" });
      outcomes.push(`${leg.exchangeId} close skipped: no execution adapter`);
      continue;
    }
    try {
      const ack = await adapter.submitExecutionOrder({
        clientOrderId: `${input.token}-${input.reason}-${leg.exchangeId}`.slice(
          0,
          96,
        ),
        symbol: input.symbol,
        side: leg.side === "long" ? "sell" : "buy",
        type: "market",
        quantityBase,
        reduceOnly: true,
      });
      closes.push({
        leg,
        orderId: ack.id,
        averageFillPriceUsd: ack.averageFillPriceUsd,
      });
      outcomes.push(`${leg.exchangeId} close submitted (${ack.id})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      closes.push({ leg, error: message });
      outcomes.push(`${leg.exchangeId} close failed: ${message}`);
    }
  }

  // 2b. Pre-persist the close attempt: legs 'unhedged' + trade 'closing'
  //     are recoverable states if this process dies mid-close (the
  //     spread-exit monitor re-runs stale 'closing' trades); a silent
  //     zombie with legs still 'open' is not.
  try {
    await input.store.transition(input.token, "closing", {
      closeReason: input.reason,
      legs: input.legs.map((leg) => ({
        exchangeId: leg.exchangeId,
        side: leg.side,
        status: "unhedged" as const,
        closeReason: input.reason,
        exitOrderId: closes.find((close) => close.leg === leg)?.orderId,
      })),
    });
  } catch (error) {
    console.warn("Close pre-persist failed; continuing to wait for flat", {
      token: input.token,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  // 3. Wait for flat and capture exit prices / venue-reported realized PnL.
  const legUpdates: TradeLegUpdate[] = [];
  let totalRealizedUsd = 0;
  let realizedKnown = true;
  for (const close of closes) {
    const adapter = input.registry.get(close.leg.exchangeId).execution;
    let flat = false;
    let exitPriceUsd: string | null = null;
    let realizedPnlUsd: string | null = null;
    if (adapter && close.orderId) {
      const deadline = now().getTime() + CLOSE_FLAT_TIMEOUT_MS;
      for (;;) {
        let position: Awaited<
          ReturnType<NonNullable<ExchangeAdapter["execution"]>["getPosition"]>
        > | null = null;
        let pollFailed = false;
        try {
          position = await adapter.getPosition({
            symbol: input.symbol,
            side: close.leg.side,
          });
        } catch {
          // A poll error is NOT proof of flatness; retry until the deadline.
          pollFailed = true;
        }
        if (
          !pollFailed &&
          (position === null || position.status === "closed")
        ) {
          // null means "no position" on these adapters; a closed status may
          // carry the venue's exit data.
          if (position !== null) {
            exitPriceUsd = position.exitPriceUsd ?? null;
            realizedPnlUsd = position.realizedPnlUsd ?? null;
          }
          flat = true;
          break;
        }
        if (now().getTime() >= deadline) break;
        await sleep(CLOSE_FLAT_POLL_MS);
      }
    } else if (adapter && close.error) {
      // The close was rejected: the venue TP/SL backstop may have already
      // closed the position. Verify before declaring the leg unhedged.
      try {
        const position = await adapter.getPosition({
          symbol: input.symbol,
          side: close.leg.side,
        });
        if (position === null || position.status === "closed") {
          if (position !== null) {
            exitPriceUsd = position.exitPriceUsd ?? null;
            realizedPnlUsd = position.realizedPnlUsd ?? null;
          }
          flat = true;
          outcomes.push(
            `${close.leg.exchangeId} already flat (close rejected: ${close.error})`,
          );
        }
      } catch {
        // Leave unhedged; the position monitor keeps watching.
      }
    }
    if (!flat) outcomes.push(`${close.leg.exchangeId} NOT flat within timeout`);

    const exit = exitPriceUsd ?? close.averageFillPriceUsd ?? null;
    if (
      !realizedPnlUsd &&
      exit &&
      close.leg.entryPriceUsd &&
      close.leg.entryPriceUsd !== "0"
    ) {
      const qty = parseDecimal(quantityBase);
      const sideMul = close.leg.side === "long" ? 1 : -1;
      const pnl =
        (parseDecimal(exit) - parseDecimal(close.leg.entryPriceUsd)) *
        qty *
        sideMul;
      realizedPnlUsd = formatDecimal(pnl, 8);
    }
    if (realizedPnlUsd) totalRealizedUsd += parseDecimal(realizedPnlUsd);
    else realizedKnown = false;

    legUpdates.push({
      exchangeId: close.leg.exchangeId,
      side: close.leg.side,
      status: flat ? "closed" : "unhedged",
      closeReason: flat ? input.reason : "close_failed",
      entryOrderId: undefined,
      entryPriceUsd: close.leg.entryPriceUsd ?? undefined,
      exitOrderId: close.orderId,
      exitPriceUsd: exit ?? undefined,
      realizedPnlUsd: realizedPnlUsd ?? undefined,
    });
  }

  // 4. Persist. A residual leg keeps the trade 'unhedged' so the monitor
  //    keeps watching it; the position monitor still notifies on closure.
  //    A persist failure must not lose the close outcome: the pre-persisted
  //    'unhedged' legs + the stale-'closing' recovery sweep finish the job.
  const residual = legUpdates.some((leg) => leg.status === "unhedged");
  try {
    await input.store.transition(
      input.token,
      residual ? "unhedged" : "closed",
      {
        closeReason: input.reason,
        realizedPnlUsd: realizedKnown
          ? formatDecimal(totalRealizedUsd, 8)
          : undefined,
        exitSpreadUsd: input.exitSpreadUsd,
        legs: legUpdates,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Trade close final persist failed", {
      token: input.token,
      label,
      message,
      outcomes,
    });
    await input
      .notify(
        `🚨 Trade ${label} closed on venue but the DB persist failed ` +
          `(${message}). Outcomes: ${outcomes.join("; ")}. ` +
          "The recovery sweep will reconcile it.",
      )
      .catch(() => undefined);
  }

  console.log("Trade spread close completed", {
    token: input.token,
    label,
    reason: input.reason,
    outcomes,
  });

  const pnlText = realizedKnown
    ? `${totalRealizedUsd >= 0 ? "+" : ""}$${totalRealizedUsd.toFixed(2)}`
    : "n/a (exit price unavailable)";
  await input.notify(
    `📕 Trade ${label} closed (${input.reason}): ${outcomes.join("; ")}. ` +
      `Realized PnL: ${pnlText}.`,
  );
  return {
    realizedPnlUsd: realizedKnown ? formatDecimal(totalRealizedUsd, 8) : null,
  };
}
