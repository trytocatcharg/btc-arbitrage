# Exploration — adjust-tpsl-volume-farming (pre-proposal, read-only)

Investigation date: 2026-09 (current tree). All findings verified against source.
Decisions grounded: `openspec/changes/adjust-tpsl-volume-farming/preproposal.md`.

## 1. TP/SL computation today + ±15% drift candidates

**Where computed/submitted:** `apps/bot/src/trading/open-trade.ts`, `runEntry()`:

- Fill anchors: `limitFillPrice = settledNotionalUsd / covered` (weighted avg of all
  limit fills, repricing-aware, ~line 660) and `marketFillPrice = hedge.averageFillPriceUsd`.
  `longEntry`/`shortEntry` are picked from those two by which exchange was limit vs market
  (~lines 668–674).
- `longTp = applyPercentChange(longEntry, tp%, "up")`, `longSl = applyPercentChange(longEntry, sl%, "down")`
  (~lines 750–760). `applyPercentChange` (line ~1013) uses `parseDecimal(percent, "percent")/100`
  — `"3"` → 3% multiplier 1.03. Correct.
- **Cross-symmetry today:** short leg is protected with `protect(..., longSl, longTp)` —
  short TP trigger = longSl, short SL trigger = longTp (~lines 764–775). Symmetric levels,
  but anchored to the **long leg's fill only**, not the short leg's own fill.
- Submitted via `protect()` (~lines 905–950): `take-profit-market` then `stop-market`,
  `reduceOnly: true`, `triggerPriceUsd: tp/sl`, qty = covered, per leg.

**Price reference used:** actual fill prices — the fill-anchoring the decision asks for is
*already* the current code. TP/SL are NOT computed from BBO/mark. Any remaining ±15% drift
must come from how the fill prices or triggers are derived at the venue layer:

**Bug candidates, ranked by likelihood:**

1. **RISEx hedge "fill price" is the position average entry, not the fill.**
   `waitForMarketFill` → `readPositionEntryPrice` (`apps/bot/src/exchanges/risex/risex-execution-adapter.ts`
   ~lines 415–485). Returns the whole-position `avg_entry_price` (blended with any
   pre-existing/residual position) or a derived `quote/size` fallback. A corrupt/blended
   value becomes `marketFillPrice` → `longEntry`/`shortEntry` → both legs' TP/SL. Documented
   fragility in-code (2026-09-14 note: `avg_entry_price: ""`, signed-size fallback bug).
2. **Trigger price type = LAST on both venues.** RISEx uses
   `StopPriceOption.LastTradedPrice`; Extended uses `triggerPriceType: "LAST"`. On thin
   venues last-price can wick far from mark/entry; an exit "at ±15% from entry" is
   consistent with a last-price trigger firing on a wick. Docs confirm `MARK_PRICE` is a
   supported alternative on RISEx (`docs/exchanges/risex-integration.md:44`).
3. **Cross-anchoring asymmetry:** short TP/SL sit at the long leg's price level
   (`longEntry × (1∓p)`), not `shortEntry × (1∓p)`. If the inter-venue spread at fill is
   wide or the long fill is repriced-stale, the short's triggers are mis-anchored by the
   full spread. Small in % on BTC but violates decision 1's per-leg anchoring; decision 1's
   cross-symmetry requirement (SL short ≈ TP long) holds *because* both venues track the
   same BTC, so per-leg anchoring ≈ symmetric levels within spread tolerance.
4. **Historical (likely already fixed):** previews carry BBO quotes (`longPriceUsd` /
   `shortPriceUsd`); if an older revision anchored TP/SL to those, a fast market during the
   up-to-120s TTL + 30s limit window explains large drift. Current tree no longer does this.
   → The tolerance assertion required by decision 1 doubles as the detector to confirm
   which of candidates 1–2 is still live.

## 2. Adapter TP/SL submission (constraints & caveats)

Interface: `packages/exchange-core/src/index.ts:54-58` — type
`"limit" | "market" | "take-profit-market" | "stop-market"`, optional `triggerPriceUsd`.

- **RISEx** (`risex-execution-adapter.ts`, TP/SL branch ~lines 155–200): requires
  `triggerPriceUsd` + `reduceOnly`; trigger rounded to price step (buy→up, sell→down);
  `deriveTpslLimitPrice` sets a limit 1 tick favorable beyond the stop; calls
  `placeTakeProfit` / `placeStopLoss` (`POST /v1/orders/tpsl`) with
  `stop_price_option: LastTradedPrice`, TIF GTC.
  - Enum/encoding caveats (`specs/exchange-execution.md`): EIP-712 `PlaceTpslOrder` /
    `CancelTpslOrder` type strings verified against official Python SDK 0.10.0; endpoint
    demands a **65-byte r‖s‖v base64 signature** (64-byte EIP-2098 compact form rejected).
  - Constraint: docs say market orders need FOK/IOC (irrelevant here, TPSL is off-chain
    trigger); trigger source `MARK_PRICE` vs `LAST_TRADED_PRICE` is a config-level choice.
- **Extended** (`extended-execution-adapter.ts`, `createOrderPayload` TPSL branch
  ~lines 185–225): signed `orderType: "TPSL"`, `tpSlType: "ORDER"`, trigger
  `{ triggerPrice (tick-rounded away from touch), triggerPriceType: "LAST", price:
  executionPrice = trigger ∓ 150bps (MARKET_CROSSING_BUFFER_BPS), priceType: "MARKET" }`;
  TP/SL must be reduce-only (enforced). Once triggered, the exit is bounded 150bps past
  the trigger.
- Both venues: trigger rounding direction is "away from touch" — with 2.5–3% offsets,
  rounding is immaterial; no trigger-vs-mark constraint beyond the LAST-price caveat above.

## 3. Spread-exit + time-stop: remove vs keep

`apps/bot/src/trading/spread-exit-monitor.ts` (`monitorSpreadExits`), wired in
`apps/bot/src/runtime/polling-loop.ts:106`:

- **REMOVE (decision 1):** spread-move comparisons — `move >= tpUsd → spread_tp`,
  `move <= -slUsd → spread_sl` (~lines 218–224) and their inputs `spreadTpUsd` /
  `spreadSlUsd` (config `OPEN_TRADE_SPREAD_TP_USD` / `OPEN_TRADE_SPREAD_SL_USD`).
- **KEEP (orthogonal):** time-stop `spread_timeout` (~line 226, config
  `OPEN_TRADE_SPREAD_EXIT_TIMEOUT_MINUTES` — likely rename to a timeout-only monitor);
  the stale-`closing` recovery sweep (top of file); the per-trade `evaluateCapturedEdge`
  gate (decision 2 extends it); and `closeTradeBothLegs`
  (`apps/bot/src/trading/trade-close.ts`) which implements the actual reduce-only market
  close with reasons `spread_tp | spread_sl | spread_timeout | edge_below_cost |
  close_recovery` — needed by decision 2's immediate-close path (`edge_below_cost` reason
  already exists).
- `apps/bot/src/trading/trade-monitor.ts` (`monitorTrades`) is the position-closure
  watcher (venue TP/SL / liquidation detection) — untouched by decision 1, and where
  TP/SL-triggered exits are recorded today.

## 4. Fill-time edge validation → breakeven band

- `evaluateCapturedEdge` (`open-trade.ts` ~lines 975–1010): `remainingEdgeUsd =
  max(0, -(longEntry - shortEntry))`; `exitCostUsd = refPrice × (longTaker + shortTaker +
  EXIT_SLIPPAGE_BPS=2) / 1e4`; `minEdgeUsd = exitCostUsd + edgeMinProfitUsd` (default
  `"10"`, option `edgeMinProfitUsd`, config `OPEN_TRADE_EDGE_MIN_PROFIT_USD`).
- Called in `runEntry` after fills (~lines 680–715) but **informational only** — operator
  decision 2026-09-16 logs and keeps the trade open. Also re-used per-tick as a gate in
  `spread-exit-monitor.ts` (~lines 160–185).
- Extension path for decision 2/D4: compute `breakevenUsd = entryFees + exitFees +
  slippage` from `options.fees` (maker bps for the limit leg, taker bps for the market leg)
  × per-leg filled notional (already tracked in `runEntry` as `settledNotionalUsd` /
  hedge notional); keep iff `expectedConvergenceUsd >= breakeven + MIN_PROFIT_USD`,
  else immediate reduce-only close via `closeTradeBothLegs` (reason `edge_below_cost`).
  The `edge_closed` `ConfirmOutcome`, `formatEdgeClosedNotice` and `reportTradeOutcome`
  plumbing in `telegram-command-poller.ts:479-559` already exists — `runEntry` just never
  returns it today; reactivating that return is the natural implementation. Max-loss band
  ($0.25) is satisfied structurally: an immediate market close loses ≈ fees + slippage,
  far below $0.25; the 2.5% venue SL remains the catastrophic backstop.

## 5. Fee inputs and fee math

- Defined in `packages/config/src/index.ts` (`BotConfig.openTrade`): `RISEX_MAKER_FEE_BPS`
  (1) / `RISEX_TAKER_FEE_BPS` (3) / `EXTENDED_MAKER_FEE_BPS` (0) /
  `EXTENDED_TAKER_FEE_BPS` (2.5) / `VARIATIONAL_*` (0/0); arcus hardcoded 0 in
  `telegram-command-poller.ts:409-411`.
- Fee math today: `evaluateCapturedEdge` (exit cost only) and
  `selectEntryExecutionExchanges` (maker/taker ranking). **Round-trip fee data at fill
  time: partially available** — bps per venue are in `options.fees`, and per-fill
  notional exists transiently in `runEntry`; but `trade_legs.entry_fee_usd` /
  `exit_fee_usd` / `funding_fee_usd` and `trades.total_fees_usd` columns are **never
  written** (schema has them, all writers omit them). Slippage estimate: `EXIT_SLIPPAGE_BPS = 2`
  constant (`open-trade.ts:78`) — a new `OPEN_TRADE_SLIPPAGE_BPS` env should replace it.

## 6. DB schema, volume columns, migration landmine

`packages/db/src/schema.ts`:

- `trades`: `entrySpreadUsd`, `exitSpreadUsd`, `realizedPnlUsd`, `unrealizedPnlUsd`,
  `totalFeesUsd` (unwritten), `openedAt/closedAt`. No volume column today.
- `tradeLegs`: `entryPriceUsd`, `exitPriceUsd`, `quantityBase`, `quantityUsd` (unwritten),
  fee columns (unwritten), `realizedPnlUsd`, `closeReason`, `raw` JSON (stores
  `tpOrderId/slOrderId/tpTriggerUsd/slTriggerUsd`).
- Writers: `apps/bot/src/trading/db-preview-store.ts` `transition()` (entry prices at
  hedge/open), `trade-close.ts` (exit prices, realized PnL), `trade-monitor.ts` (venue-side
  closure). There is **no fill-event table** — volume must be aggregated at these writers.
- Volume placement: `trades.filled_notional_usd` (decimal(24,8), sum over all leg fills of
  the trade) is the minimum for the Telegram summary + future endpoint; optionally
  `tradeLegs.filled_notional_usd` for per-leg granularity. Aggregation points: `runEntry`
  fill loop (limit: `settledNotionalUsd` already exact across reprices; hedge:
  `diff × hedge.averageFillPriceUsd`), `trade-close.ts` step 2 closes
  (`quantityBase × ack.averageFillPriceUsd`, with position-derived exit price fallback in
  step 3), and `trade-monitor.ts` (venue TP/SL exits — only exit price is known there, so
  leg volume increment = qty × exitPrice). Because multiple writers touch it, prefer
  incrementing a monotonic column (`filled_notional_usd = coalesce + :delta`) inside the
  existing transactions to stay crash-safe.
- **Migration landmine (AGENTS.md:268):** `migrations/meta/` has no `0001_snapshot.json`,
  and migration 0001 did not widen `trade_status_history` enum columns while `schema.ts`
  types them with the full 10-value set. → New columns need a hand-written `0003_*.sql`
  (`ALTER TABLE ... ADD COLUMN`); do not trust `drizzle-kit generate` diff parity, and do
  not add new enum values to `trades.status`/`trade_legs.status` (the history-table width
  mismatch would bite).

## 7. Telegram trade summary paths

- Opened-trade summary: `buildFillSummary` (`telegram-command-poller.ts:561-581`) — add a
  farmed-volume line (legs' entry notional sum, or read `trades.filled_notional_usd`).
- Close notice: final `notify` in `trade-close.ts` ("📕 Trade X closed (reason)…") — add
  cumulative volume at close.
- Active-trades `/summary`: `apps/bot/src/notifications/trade-summary.ts`
  (`buildTradeSummaryMessage`) — currently estimates "Total notional" from live prices;
  add a DB-backed lifetime/period farmed-volume line here.
- Config echo: `formatActiveConfigSummary` (`telegram-command-poller.ts:628`) — update for
  removed spread vars / new defaults (SL 2.5%, MIN_PROFIT_USD, MAX_LOSS_USD, slippage bps).

## 8. Backend routes (follow-up only)

`apps/backend/src/server.ts` confirms balances-only: `/health`,
`/api/exchanges/balances`, `/api/exchanges/risex/balance`,
`/api/exchanges/extended/balance` — no trade/volume reads. A future read-only volume-stats
endpoint would add a GET route here + a query service over `trades.filled_notional_usd`
(grouped by day/exchange). Guardrail: `specs/exchange-execution.md` requires backend
routes stay read-only — a GET stats endpoint is compliant. Out of scope for this change.

## 9. Config plumbing pattern for new env vars

Flow: `loadBotConfig(env)` parses/validates (`parsePositiveDecimalString` /
`parseNonNegativeDecimalString`) → `BotConfig.openTrade.*` → wired in
`telegram-command-poller.ts openTradeService()` (options) and `polling-loop.ts:106`
(monitor inputs) → echoed by `formatActiveConfigSummary`; `.env.example` documents.
Mirroring additions:

- `OPEN_TRADE_STOP_LOSS_PERCENT` default `"3"` → `"2.5"` (one-line default change).
- `OPEN_TRADE_MIN_PROFIT_USD` default `"0.05"` (extend/replace `OPEN_TRADE_EDGE_MIN_PROFIT_USD`,
  whose default `"10"` would otherwise contradict the cents-level farming goal).
- `OPEN_TRADE_MAX_LOSS_USD` default `"0.25"` (abort-band guard for the immediate close).
- `OPEN_TRADE_SLIPPAGE_BPS` default `"2"` (replaces the `EXIT_SLIPPAGE_BPS` constant).
- Remove `OPEN_TRADE_SPREAD_TP_USD` / `OPEN_TRADE_SPREAD_SL_USD` (keep
  `OPEN_TRADE_SPREAD_EXIT_TIMEOUT_MINUTES`, likely renamed).

## 10. Blast radius (decisions 1–3)

- `apps/bot/src/trading/open-trade.ts` — per-leg fill anchoring (short leg anchored to its
  own fill), drift tolerance assertion, edge eval → breakeven band, reactivate
  `edge_closed`, volume accumulation.
- `apps/bot/src/trading/spread-exit-monitor.ts` — delete spread TP/SL; keep timeout +
  recovery + edge gate (possibly rename to timeout-close monitor).
- `apps/bot/src/trading/trade-close.ts` — reason renames (`spread_timeout` → timeout),
  volume on close fills.
- `apps/bot/src/trading/db-preview-store.ts` — persist volume columns (transition details).
- `apps/bot/src/trading/trade-monitor.ts` — volume increment on venue-side closure.
- `apps/bot/src/runtime/polling-loop.ts` — wiring of new config inputs.
- `apps/bot/src/notifications/telegram-command-poller.ts` — config plumbing, fill-summary
  volume line, config echo text.
- `apps/bot/src/notifications/trade-summary.ts` — volume line.
- `packages/config/src/index.ts`, `.env.example` — new/changed/removed env vars + interface.
- `packages/db/src/schema.ts` + `packages/db/migrations/0003_*.sql` (hand-written) —
  volume columns.
- Typecheck-only risk: `apps/bot/test/open-trade.test.ts` (lines 117-118, 288-289) passes
  `takeProfitPercent`/`stopLossPercent` options; any `OpenTradeOptions` shape change must
  keep these compiling (unit tests are paused per user instruction, but `tsc` still covers
  test files if included in the project's typecheck).
- Docs: `AGENTS.md` env table (line ~151), `specs/bot.md` spread-exit wording.

## Open tensions to resolve in proposal (not explore)

- D1 vs D2/D4 reconciliation is already sketched in the preproposal; the code confirms it
  is implementable with existing machinery (`edge_below_cost` close + `edge_closed`
  outcome + `evaluateCapturedEdge` extension).
- Whether `OPEN_TRADE_EDGE_MIN_PROFIT_USD` is replaced by or aliased to
  `OPEN_TRADE_MIN_PROFIT_USD` (config migration preference is a proposal decision).
- Telegram "trade summary" for decision 3 = `buildFillSummary` + close notice; the
  `/summary` command addition is cheap and DB-backed.
