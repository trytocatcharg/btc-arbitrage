import { and, eq, inArray, notInArray } from "drizzle-orm";
import {
  activeTradeStatuses,
  tradeLegs,
  trades,
  type getDb,
} from "@btc-arbitrage/db";
import type { BotConfig } from "@btc-arbitrage/config";
import type { ExchangeAdapter } from "@btc-arbitrage/exchange-core";
import { parseDecimal } from "@btc-arbitrage/domain";
import { GOLD_SILVER_SYMBOL } from "@btc-arbitrage/domain";

/**
 * The GOLD/SILVER pseudo-pair is Arcus-only and monitor-only (v1): it never
 * creates DB legs and no spread-exchange adapter resolves its symbol, so
 * the per-(exchange, side) position scan below has nothing legitimate to
 * read there. Skip the scan wholesale while it is active — reporting the
 * exchanges as unread would trip the entry block and the episode alert on
 * every pass for a market the spread venues simply do not list.

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
 *
 * Work unit 2 (2026-10-21): findings and the block state carry the position
 * side, and the arm alert carries a "Close position" inline button handled
 * by the Telegram command poller (untracked: callback family, two-step
 * operator confirm). scanUntrackedPositions() exposes the same comparison
 * read-only — no throttle, no state mutation, no notify — for the on-demand
 * /trade Active-trade view.
 */

/** Dust threshold (BTC): quantities at or below this are "no position". */
const POSITION_EPSILON_BASE = 1e-6;

/** Structural Telegram inline-keyboard shape for the untracked alert's
 * Close-position button. Defined here instead of imported from the
 * notifier to avoid a notifications → trading import cycle. */
export interface UntrackedKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

/** One untracked exchange position found by the scan: an exchange-reported
 * position with no matching ACTIVE trade legs in the DB. */
export interface UntrackedScanFinding {
  exchangeId: string;
  side: "long" | "short";
  quantityBase: string;
}

export interface UntrackedScanResult {
  findings: UntrackedScanFinding[];
  /** Exchanges whose position could NOT be verified this scan (per-exchange
   * position-read failure; also every configured exchange when the
   * active-leg query itself failed, because then nothing can be checked).
   * Lets the caller distinguish "none found" from "could not check". */
  readFailedExchanges: string[];
}

/** The one untracked episode the process is blocking on, if any. Read by the
 * OpenTrade entry guard; owned exclusively by this module. */
let untrackedPosition: {
  exchangeId: string;
  side: "long" | "short";
  quantityBase: string;
  detectedAt: string;
  /** Whether the urgent arm alert was delivered. A failed delivery leaves
   * this false so the next pass retries the alert — the block must never
   * run silently (verifier finding, 2026-10-21). */
  alerted: boolean;
} | null = null;

/** Wall-clock (ms) of the last completed run. Module-level: the cadence
 * survives across monitor passes but not restarts — a restart simply
 * reconciles on the first pass, which is the desired on-boot check. */
let lastCompletedRunMs: number | null = null;

/** Current untracked-position block, consumed by the OpenTrade entry guard.
 * Returns null when no untracked episode is active. */
export function getUntrackedPosition(): {
  exchangeId: string;
  side: "long" | "short";
  quantityBase: string;
  detectedAt: string;
} | null {
  return untrackedPosition;
}

export async function runPositionReconciliation(input: {
  db: Awaited<ReturnType<typeof getDb>>;
  registry: { get(id: string): ExchangeAdapter };
  config: BotConfig;
  notify: (text: string, keyboard?: UntrackedKeyboard) => Promise<void>;
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

/** Urgent arm alert with delivery tracking: a throwing notify logs a warn
 * and leaves `state.alerted` false so a later pass retries — the block
 * must never run silently. Never throws. */
async function alertUntracked(
  input: {
    notify: (text: string, keyboard?: UntrackedKeyboard) => Promise<void>;
  },
  finding: UntrackedScanFinding,
  state: { alerted: boolean },
): Promise<void> {
  try {
    await input.notify(
      `🚨 UNTRACKED POSITION on ${finding.exchangeId}: ` +
        `${finding.quantityBase} BTC with no matching active trade legs in the DB. ` +
        `New trades are BLOCKED until the position is closed or accounted for ` +
        `(position reconciler).`,
      {
        inline_keyboard: [
          [
            {
              text: "🚨 Close position",
              callback_data: `untracked:close:${finding.exchangeId}:${finding.side}`,
            },
          ],
        ],
      },
    );
    state.alerted = true;
  } catch (error) {
    console.warn(
      "Position reconciliation untracked-position alert failed; will retry next pass",
      error instanceof Error ? { message: error.message } : { error },
    );
  }
}

/** Read-only untracked-position scan: the SAME comparison the periodic
 * reconciler pass runs (exchange-reported position vs ACTIVE DB leg
 * quantities per exchange+side), but with no throttle, no module-state
 * mutation and no notify. Shared by reconcileOnce (episode transitions)
 * and by the on-demand /trade Active-trade view. Never throws on exchange
 * or DB errors: a failed exchange read contributes no findings and lands
 * in readFailedExchanges; a failed active-leg query means nothing can be
 * verified, so every configured exchange is reported as unread (callers
 * must never mistake that result for "flat"). */
export async function scanUntrackedPositions(input: {
  db: Awaited<ReturnType<typeof getDb>>;
  registry: { get(id: string): ExchangeAdapter };
  config: BotConfig;
}): Promise<UntrackedScanResult> {
  const exchangeIds = [
    ...new Set([input.config.exchangeA, input.config.exchangeB]),
  ];

  // Arcus-only monitor pair: no DB legs can exist and the spread exchanges
  // cannot hold a GOLDSILVER position (see module header).
  if (input.config.btcSymbol === GOLD_SILVER_SYMBOL) {
    return { findings: [], readFailedExchanges: [] };
  }

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
          // Terminal leg states never hold a position; exclude them so a
          // future non-terminal status stays tracked automatically
          // (whitelist would silently drop it — verifier finding).
          notInArray(tradeLegs.status, [
            "closed",
            "cancelled",
            "failed",
          ]),
        ),
      );
  } catch (error) {
    console.warn(
      "Position reconciliation skipped: active-leg query failed",
      error instanceof Error ? { message: error.message } : { error },
    );
    // Without the tracked-leg quantities nothing can be checked: report
    // every configured exchange as unread so the periodic pass never
    // clears a block (and the /trade view never claims "none") on this.
    return { findings: [], readFailedExchanges: exchangeIds };
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

  const findings: UntrackedScanFinding[] = [];
  const readFailedExchanges = new Set<string>();

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
        findings.push({
          exchangeId,
          side,
          quantityBase: positionQuantityBase,
        });
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

  return { findings, readFailedExchanges: [...readFailedExchanges] };
}

async function reconcileOnce(input: {
  db: Awaited<ReturnType<typeof getDb>>;
  registry: { get(id: string): ExchangeAdapter };
  config: BotConfig;
  notify: (text: string, keyboard?: UntrackedKeyboard) => Promise<void>;
}): Promise<void> {
  const scan = await scanUntrackedPositions(input);
  const { findings } = scan;
  const readFailedExchanges = new Set(scan.readFailedExchanges);

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
      // untracked): arm the entry guard FIRST (fail closed), then attempt
      // the alert. A throwing notify must not lose the episode: alerted
      // stays false and a later pass retries the delivery.
      untrackedPosition = {
        exchangeId: finding.exchangeId,
        side: finding.side,
        quantityBase: finding.quantityBase,
        detectedAt: new Date().toISOString(),
        alerted: false,
      };
      await alertUntracked(input, finding, untrackedPosition);
    } else if (!untrackedPosition.alerted) {
      // Arm alert still undelivered (earlier notify failed): retry once
      // per pass until Telegram accepts it — the block never runs silent.
      await alertUntracked(input, finding, untrackedPosition);
    } else if (
      Math.abs(
        parseDecimal(finding.quantityBase, "quantityBase") -
          parseDecimal(untrackedPosition.quantityBase, "quantityBase"),
      ) > POSITION_EPSILON_BASE
    ) {
      // Same episode, materially changed size: refresh without re-alerting.
      // The side is refreshed too: a flip (old side closed, opposite side
      // now untracked on the same venue) must not leave a stale side in
      // the block state the Close button flow validates against.
      untrackedPosition = {
        ...untrackedPosition,
        side: finding.side,
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
    try {
      await input.notify(
        `✅ Untracked position on ${resolved.exchangeId} resolved — ` +
          `no exchange position beyond tracked legs remains. ` +
          `New trade entries are unblocked.`,
      );
    } catch (error) {
      // The block is already cleared (the safety-critical part); only the
      // resolution notice is lost. Log for the operator.
      console.warn(
        "Position reconciliation resolution alert failed",
        error instanceof Error ? { message: error.message } : { error },
      );
    }
  }
}
