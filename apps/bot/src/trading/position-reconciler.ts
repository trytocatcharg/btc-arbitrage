import { and, eq, inArray } from "drizzle-orm";
import {
  activeTradeStatuses,
  tradeLegs,
  trades,
  type getDb,
} from "@btc-arbitrage/db";
import type { BotConfig } from "@btc-arbitrage/config";
import type { ExchangeAdapter } from "@btc-arbitrage/exchange-core";
import { parseDecimal } from "@btc-arbitrage/domain";

/**
 * Position reconciler (position-reconciler, P0 — 2026-10-21 incident).
 *
 * A naked position once existed on Extended with no DB leg and no TP/SL; the
 * bot only discovered it when a new entry was rejected for insufficient
 * margin. This module closes that gap: on every monitor pass (throttled by
 * POSITION_RECONCILE_INTERVAL_MS, 0 disables) it compares each
 * execution-capable exchange's reported position against the quantities of
 * the bot's ACTIVE trade legs and fails closed on an untracked excess:
 *
 *   untrackedBase = positionQty − sum(activeLegQty)  per (exchange, side)
 *
 * - untrackedBase > EPSILON  → untracked position: urgent alert ONCE per
 *   episode and a module-level block that OpenTradeService.confirm() reads
 *   via getUntrackedPosition() to refuse new entries.
 * - position gone (≤ EPSILON) → "no position"; a blocked episode clears on
 *   the first pass that re-reads that exchange successfully and sees the
 *   excess resolved, with a resolved alert.
 * - position < leg sum → log only: the trade monitor owns leg-closure
 *   detection (this is the normal mid-entry / mid-close shape).
 *
 * Read failures degrade per exchange: a failed getPosition logs a warn and
 * that exchange is UNKNOWN for the pass — it never creates a block and never
 * clears an existing one. Nothing here throws on exchange/DB errors; the
 * monitor pass still wraps the call in its own try/catch.
 *
 * Exchange universe: the registry only exposes get(id), so the reconciler
 * walks the configured monitored pair (config.exchangeA / config.exchangeB)
 * — the only venues the bot can ever open legs on.
 *
 * Active-leg source of truth: legs joined to trades in activeTradeStatuses
 * (design note's executing_limit|hedging|protecting|open|closing|unhedged
 * is the TRADE status set exported by @btc-arbitrage/db), excluding legs in
 * terminal states (closed/cancelled/failed — e.g. the closed sibling of an
 * unhedged trade). Leg quantityBase NULL (planned/not yet filled) counts 0.
 */

/** Dust threshold (BTC): quantities at or below this are "no position". */
const POSITION_EPSILON_BASE = 1e-6;

/** The one untracked episode the process is blocking on, if any. Read by the
 * OpenTrade entry guard; owned exclusively by this module. */
let untrackedPosition: {
  exchangeId: string;
  quantityBase: string;
  detectedAt: string;
} | null = null;

/** Wall-clock (ms) of the last completed run. Module-level: the cadence
 * survives across monitor passes but not restarts — a restart simply
 * reconciles on the first pass, which is the desired on-boot check. */
let lastCompletedRunMs: number | null = null;

/** Current untracked-position block, consumed by the OpenTrade entry guard.
 * Returns null when no untracked episode is active. */
export function getUntrackedPosition(): {
  exchangeId: string;
  quantityBase: string;
  detectedAt: string;
} | null {
  return untrackedPosition;
}

export async function runPositionReconciliation(input: {
  db: Awaited<ReturnType<typeof getDb>>;
  registry: { get(id: string): ExchangeAdapter };
  config: BotConfig;
  notify: (text: string) => Promise<void>;
}): Promise<void> {
  const intervalMs = input.config.positionReconcileIntervalMs;
  // 0 disables the feature entirely.
  if (intervalMs <= 0) return;
  const nowMs = Date.now();
  // The interval check lives here (not in the caller) so the monitor pass
  // can invoke the reconciler unconditionally every pass.
  if (lastCompletedRunMs !== null && nowMs - lastCompletedRunMs < intervalMs)
    return;
  try {
    await reconcileOnce(input);
  } finally {
    // A failed run still starts the interval: erroring exchanges must not
    // hot-spin the reconciler on every 1 s monitor pass.
    lastCompletedRunMs = nowMs;
  }
}

async function reconcileOnce(input: {
  db: Awaited<ReturnType<typeof getDb>>;
  registry: { get(id: string): ExchangeAdapter };
  config: BotConfig;
  notify: (text: string) => Promise<void>;
}): Promise<void> {
  // Sum ACTIVE leg quantities per (exchange, side). Terminal leg states are
  // excluded even inside an active trade: a closed sibling of an unhedged
  // trade holds no exchange position.
  let legRows: Array<{
    exchangeId: string;
    side: "long" | "short";
    quantityBase: string | null;
  }>;
  try {
    legRows = await input.db
      .select({
        exchangeId: tradeLegs.exchangeId,
        side: tradeLegs.side,
        quantityBase: tradeLegs.quantityBase,
      })
      .from(tradeLegs)
      .innerJoin(trades, eq(tradeLegs.tradeId, trades.id))
      .where(
        and(
          inArray(trades.status, [...activeTradeStatuses]),
          inArray(tradeLegs.status, [
            "planned",
            "submitted",
            "open",
            "unhedged",
          ]),
        ),
      );
  } catch (error) {
    console.warn(
      "Position reconciliation skipped: active-leg query failed",
      error instanceof Error ? { message: error.message } : { error },
    );
    return;
  }

  const legQtyByExchangeSide = new Map<string, number>();
  for (const row of legRows) {
    if (row.quantityBase == null) continue;
    const key = `${row.exchangeId}:${row.side}`;
    legQtyByExchangeSide.set(
      key,
      (legQtyByExchangeSide.get(key) ?? 0) +
        parseDecimal(row.quantityBase, "quantityBase"),
    );
  }

  const findings: Array<{ exchangeId: string; quantityBase: string }> = [];
  const readFailedExchanges = new Set<string>();
  const exchangeIds = [
    ...new Set([input.config.exchangeA, input.config.exchangeB]),
  ];

  for (const exchangeId of exchangeIds) {
    const execution = input.registry.get(exchangeId).execution;
    // Adapters without execution (market-data-only venues) cannot hold a
    // bot position; every execution-capable venue is reconciled, including
    // arcus since live-trading support shipped (2026-10).
    if (!execution) continue;

    for (const side of ["long", "short"] as const) {
      let positionQty = 0;
      let positionQuantityBase = "0";
      try {
        const position = await execution.getPosition({
          symbol: input.config.btcSymbol,
          side,
        });
        if (position !== null && position.status !== "closed") {
          positionQty = parseDecimal(
            position.quantityBase,
            "positionQuantityBase",
          );
          positionQuantityBase = position.quantityBase;
        }
      } catch (error) {
        // Unknown, not flat: never create or clear a block from a failed
        // read (missing credentials on a disabled venue land here too).
        readFailedExchanges.add(exchangeId);
        console.warn(
          "Position reconciliation position read failed",
          error instanceof Error
            ? { exchangeId, side, message: error.message }
            : { exchangeId, side, error },
        );
        break;
      }

      if (positionQty <= POSITION_EPSILON_BASE) continue;

      const legSum = legQtyByExchangeSide.get(`${exchangeId}:${side}`) ?? 0;
      const untrackedBase = positionQty - legSum;
      if (untrackedBase > POSITION_EPSILON_BASE) {
        findings.push({ exchangeId, quantityBase: positionQuantityBase });
        console.warn("Position reconciliation found untracked position", {
          exchangeId,
          side,
          positionQuantityBase,
          trackedLegQuantityBase: legSum,
        });
      } else if (positionQty < legSum - POSITION_EPSILON_BASE) {
        // Position smaller than the tracked leg sum: normal mid-entry /
        // mid-close shape — the trade monitor owns leg-closure detection.
        console.log(
          "Position reconciliation: position below tracked leg sum",
          { exchangeId, side, positionQuantityBase, trackedLegQuantityBase: legSum },
        );
      }
    }
  }

  // Episode transitions: alert once per episode, keep the block fresh while
  // the episode lasts, and clear only on a confirmed resolution.
  if (findings.length > 0) {
    // Prefer the already-blocked exchange when still untracked, so the
    // episode identity stays stable across passes.
    const finding =
      findings.find((f) => f.exchangeId === untrackedPosition?.exchangeId) ??
      findings[0];
    if (
      untrackedPosition === null ||
      untrackedPosition.exchangeId !== finding.exchangeId
    ) {
      // New episode (none → detected, or a different venue became
      // untracked): (re)alert and (re)arm the entry guard.
      untrackedPosition = {
        exchangeId: finding.exchangeId,
        quantityBase: finding.quantityBase,
        detectedAt: new Date().toISOString(),
      };
      await input.notify(
        `🚨 UNTRACKED POSITION on ${finding.exchangeId}: ` +
          `${finding.quantityBase} BTC with no matching active trade legs in the DB. ` +
          `New trades are BLOCKED until the position is closed or accounted for ` +
          `(position reconciler).`,
      );
    } else if (
      Math.abs(
        parseDecimal(finding.quantityBase, "quantityBase") -
          parseDecimal(untrackedPosition.quantityBase, "quantityBase"),
      ) > POSITION_EPSILON_BASE
    ) {
      // Same episode, materially changed size: refresh without re-alerting.
      untrackedPosition = {
        ...untrackedPosition,
        quantityBase: finding.quantityBase,
      };
    }
  } else if (
    untrackedPosition !== null &&
    !readFailedExchanges.has(untrackedPosition.exchangeId)
  ) {
    // Detected → none, confirmed by a successful read of the blocked
    // exchange: clear the block and notify the resolution.
    const resolved = untrackedPosition;
    untrackedPosition = null;
    await input.notify(
      `✅ Untracked position on ${resolved.exchangeId} resolved — ` +
        `no exchange position beyond tracked legs remains. ` +
        `New trade entries are unblocked.`,
    );
  }
}
