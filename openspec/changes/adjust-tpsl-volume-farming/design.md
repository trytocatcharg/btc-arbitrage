# Design — adjust-tpsl-volume-farming

## Context

The bot's primary objective is **farming trading volume** on BTC perpetuals, yet the current exit/anchoring model undermines it in three ways (evidence in `explore.md`):

1. **Spread-USD exits** (`spread-exit-monitor.ts:218-224`) close trades on live-spread moves against USD thresholds — an exit model oriented to convergence profit, not volume. The fill-time edge check (`evaluateCapturedEdge`, `open-trade.ts:975-1010`) is informational-only (operator decision 2026-09-16): trades with net-negative expected value are kept open.
2. **±15% TP/SL drift**: the short leg is protected with the *long leg's* trigger levels (`open-trade.ts:764-775`, `protect(..., longSl, longTp)`); the RISEx hedge "fill price" comes from `readPositionEntryPrice` (whole-position `avg_entry_price`, blended with residual positions — in-code 2026-09-14 note documents `avg_entry_price: ""` and a signed-size fallback bug); and both venues trigger on LAST price, which wicks on thin books.
3. **Farmed volume is nowhere**: no volume column, no fill-event table, no Telegram surface, no API.

Constraints (from `AGENTS.md`): unit tests are paused (verification is `yarn typecheck` + dry-run evidence; `apps/bot/test/open-trade.test.ts:117-118,288-289` must keep compiling); migration drift landmine (`migrations/meta/` has no `0001_snapshot.json` → no `drizzle-kit generate`, no new enum values); execution gates are display-only (per-adapter gates unchanged); backend and web are strictly read-only; no axios.

Stakeholders: single-operator Telegram user; the sdd-tasks phase (delivery strategy may chain PRs per DP6 note); future reviewers of the paused test suite.

## Goals / Non-Goals

**Goals**

- Per-leg TP (3%) / SL (2.5%) anchored to each leg's *own* true fill price, with a 100 bps tolerance assertion + cross-symmetry check that fails loudly (urgent notify + `claimRollback`).
- MARK_PRICE triggers on RISEx (`stop_price_option: MarkPrice`); Extended stays LAST with its 150 bps `MARKET_CROSSING_BUFFER_BPS` bound.
- Fee-aware fill-time edge band: keep iff `expectedConvergenceUsd ≥ roundTripBreakeven + OPEN_TRADE_MIN_PROFIT_USD`, else immediate reduce-only abort (`edge_below_cost`) reactivating the dormant `edge_closed` `ConfirmOutcome`, with an `OPEN_TRADE_MAX_LOSS_USD` runtime assertion.
- Spread-USD exits deleted (env vars rejected at config load); time-stop + stale-`closing` sweep retained.
- `filled_notional_usd` persisted monotonically (`coalesce + delta`) at the three existing writers; surfaced in fill summary, close notice, `/summary`.
- Read-only `GET /api/trades/volume-stats` (lifetime + 24h/7d/30d windows + per-venue) + web dashboard panel on the 30 s refresh.
- Config surface updated; legacy vars fail fast.

**Non-Goals** (unchanged): no auto-trading or execution-gate changes; no unit-test re-enabling; no new enum values; no `drizzle-kit generate`; no fill-event table; no mutating routes; no changes to signal suppression or the polling-loop `continue` quirk.

## Decisions

### D1. Protection placement flow in `runEntry()`

**Where computation/anchoring lives.** In `open-trade.ts runEntry()`, immediately after `longEntry`/`shortEntry` are resolved (`open-trade.ts:668-674`) and *before* the `store.transition(token, "protecting", ...)` call (~line 717):

1. Compute per-leg triggers via existing `applyPercentChange`: long leg — `longTp = longEntry × 1.03`, `longSl = longEntry × 0.975`; short leg — `shortTp = shortEntry × 0.975` (short profits when price falls, so its take-profit is a *buy* trigger below its fill) and `shortSl = shortEntry × 1.03`. This replaces the cross-anchor (`protect(..., longSl, longTp)` for the short leg at `open-trade.ts:764-775`) with per-leg anchors: `protect(..., shortTp, shortSl)` for the short leg. The cross-symmetry property (`shortTp ≈ longSl`, `shortSl ≈ longTp` — both venues track the same BTC) is then *verified*, not assumed by construction.
2. **Tolerance assertion + cross-symmetry check** run in a pure helper (new `assertProtectionAnchors(input)` in `open-trade.ts` or `packages/domain`): for each trigger, assert `|trigger − fill×(1±p)| / (fill×(1±p)) ≤ 100 bps`; assert `|shortSl − longTp|/longTp ≤ 100 bps` and `|shortTp − longSl|/longSl ≤ 100 bps`. Log the full anchor set on pass (this doubles as the live detector for which drift candidate is still firing). On breach → `throw new ProtectionAnchorError(...)`.
3. **Loud-failure path**: the throw lands in the existing `runEntry` catch block, which already cancels working orders, calls `store.claimRollback(token)`, submits emergency reduce-only market closes for `covered` quantity, verifies flatness, transitions to `failed`/`unhedged`, and `notifyUrgent`s. No new failure machinery is needed — the assertion rides the existing rollback path. **Alternative considered**: return a dedicated outcome and let the poller handle it — rejected because the fills already happened (positions exist); only the rollback path safely closes them, and `edge_closed`-style outcomes cannot express "protection refused".

**Fill-price integrity for the RISEx hedge (see D2) is checked at the same step**: if the hedge fill price resolved to a blank or signed-size-fallback position average and no true fill price exists, the protection step throws the same loud-failure error *before* any protection order is placed.

### D2. True fill price for the RISEx hedge

**Decision.** The hedge order ack is the authoritative source. In `runEntry()`, the hedge is submitted via `adapter.submitExecutionOrder({type: "market", ...})`; the returned ack already carries `averageFillPriceUsd` (used today at `open-trade.ts:~671` as `marketFillPrice = hedge.averageFillPriceUsd`). Two gaps remain:

1. `waitForMarketFill` on RISEx (`risex-execution-adapter.ts:415-485`) polls positions and returns `readPositionEntryPrice` (position average) — not the order's fills. **Change**: make the RISEx adapter's market-fill wait *first* attempt to read the order's own fill/average price from the order-status endpoint (`GET /v1/orders` by id, or the ack payload if it already includes `average_fill_price`); return the position average only when the order-level read fails. The adapter returns the price *plus a provenance flag* (`source: "order_ack" | "position_average"`).
2. In `runEntry()`: if provenance is `order_ack` → use directly. If `position_average` → still use it (documented fallback, needed for Extended-style flows and RISEx order-read outages) but run it through the integrity check: blank string, non-positive, signed-size-fallback derivation (the adapter logs/flags this), or a value that fails the 100 bps tolerance against the *limit leg's* fill (same-BTC sanity bound) → loud failure per D1.

**Alternatives considered.** (a) Always hard-fail on position-average fallback — rejected: it would block all hedges whenever the RISEx order-read endpoint hiccups, and the fallback is usually correct when the account was flat. (b) Fetch fills from a new exchange endpoint contract — rejected: changes `ExecutionAdapter` for a single-venue concern; per-venue specs discourage unprompted contract changes. Chosen: prefer order ack, tolerate position average only when it passes integrity + tolerance checks, fail loudly otherwise.

### D3. Trigger price type plumbing

**Decision.** **Adapter-layer constant**, not a per-call parameter. RISEx: change `StopPriceOption.LastTradedPrice` → `StopPriceOption.MarkPrice` at the two `placeTakeProfit`/`placeStopLoss` call sites (`risex-execution-adapter.ts:215,224`). Extended: unchanged (`triggerPriceType: "LAST"` + `MARKET_CROSSING_BUFFER_BPS`).

**Rationale / alternatives.** A new `triggerPriceType` field on `ExecutionOrderInput` (`packages/exchange-core/src/index.ts:54-58`) was considered and rejected: the exchange-core contract is venue-agnostic, LAST-vs-MARK is a venue-capability distinction (Extended has no MARK option), and a per-call param invites callers to set an unsupported value on Extended. A module-level constant keeps the venue spec (`docs/exchanges/risex-integration.md:44`) as the single source of truth; the extended adapter stays untouched. Asymmetry is acceptable: both venues track the same BTC mark within normal basis, and the D1 tolerance assertion quantifies residual asymmetry.

### D4. Edge band computation and abort flow

**Sequence at fill time** (in `runEntry()`, after fills complete, replacing the informational `evaluateCapturedEdge` block at `open-trade.ts:680-715`):

1. `expectedConvergenceUsd = max(0, longEntry − shortEntry)` (unchanged semantics).
2. `breakevenUsd = entryFees + exitFees + slippage`:
   - `entryFees = limitNotional × makerBps(limitVenue)/1e4 + hedgeNotional × takerBps(hedgeVenue)/1e4` — from `options.fees` (maker for the limit leg, taker for the market leg).
   - `exitFees = (limitNotional + hedgeNotional) × takerBps(venue)/1e4` per leg's venue.
   - `slippage = exitNotional × OPEN_TRADE_SLIPPAGE_BPS/1e4` (default 2), replacing the `EXIT_SLIPPAGE_BPS` constant (`open-trade.ts:78`).
   - Notionals come from data already transient in `runEntry`: `settledNotionalUsd` (limit, exact across reprices) and `hedge.averageFillPriceUsd × qty`.
3. **Keep/abort**: keep iff `expectedConvergenceUsd ≥ breakevenUsd + options.minProfitUsd` (`OPEN_TRADE_MIN_PROFIT_USD`, default `"0.05"`). Note the informational monitor call inside `spread-exit-monitor.ts:160-185` also uses `evaluateCapturedEdge` — that per-tick gate is deleted along with spread exits (D5).
4. **Abort path**: `await closeTradeBothLegs({ ..., reason: "edge_below_cost", legs: [...entryPriceUsd: longEntry/shortEntry...] })` — already-implemented machinery (`trade-close.ts`), already includes the 2b pre-persist of `closing`/`unhedged` for crash recovery. Then return `{ outcome: "edge_closed", realizedPnlUsd, capturedSpreadUsd, minEdgeUsd }` from `runEntry`.
5. **`edge_closed` reactivation**: `telegram-command-poller.ts:479-559` already handles this outcome (`reportTradeOutcome` → `formatEdgeClosedNotice`); `runEntry` simply never returns it today. No new plumbing.
6. **`OPEN_TRADE_MAX_LOSS_USD` runtime assertion**: on the abort path, after close, compare `|realizedPnlUsd|` (when known) against `maxLossUsd`; if exceeded, `console.error` + `notifyUrgent` ("fee-model drift detected") but do not throw — the trade is already closed.

**Why a one-shot gate over a per-tick gate**: the band's inputs (fill prices, fees) are knowable exactly once, at fill; per-tick re-evaluation reuses stale fills and contradicts the standing venue TP/SL layer. **Why keep + abort instead of veto-before-fill**: fills are required to know the true capture; the abort loses only ≈fees+slippage ≪ $0.25.

### D5. Spread-exit monitor surgery

**Deleted**: `spreadTpUsd`/`spreadSlUsd` inputs and the `move >= tpUsd → spread_tp` / `move <= -slUsd → spread_sl` comparisons (`spread-exit-monitor.ts:218-224`); the per-tick `evaluateCapturedEdge` gate (`:160-185`) and its `edgeMinProfitUsd`/`takerFeesBps` inputs; `priceByExchange` becomes unnecessary for exits (only `openedAt` matters now) — keep the parameter only if the timeout path still wants logging; simplest is to drop it.

**Retained**: the stale-`closing` recovery sweep (top of file, `close_recovery`) and the time-stop (`spread_timeout`, `OPEN_TRADE_SPREAD_EXIT_TIMEOUT_MINUTES`, default 30). The claim-into-`closing` + `closeTradeBothLegs` invocation stays, minus the spread math.

**Rename**: yes — `monitorSpreadExits` → `monitorTimeoutClosures` (file `spread-exit-monitor.ts` → `timeout-close-monitor.ts`), config `spreadExitTimeoutMinutes` → `openTradeCloseTimeoutMinutes` *internally* but **env var name unchanged** (`OPEN_TRADE_SPREAD_EXIT_TIMEOUT_MINUTES` kept, default 30 — renaming the env var would add breaking churn for zero benefit). Close reason enum values `spread_timeout`/`close_recovery` **kept as-is** (persisted in DB `close_reason` strings and referenced in specs; renaming them is a data-migration non-goal). **Alternative considered**: full rename of reasons — rejected: touches DB history semantics and paused tests for cosmetic gain.

### D6. Volume aggregation design

**Schema** (`packages/db/src/schema.ts`): add `filledNotionalUsd: decimal('filled_notional_usd', { precision: 24, scale: 8 }).notNull().default('0')` to both `trades` and `tradeLegs` (money-column convention).

**Migration** — hand-written `packages/db/migrations/0003_filled_notional_volume.sql`:

```sql
ALTER TABLE `trades` ADD COLUMN `filled_notional_usd` decimal(24,8) NOT NULL DEFAULT 0;
ALTER TABLE `trade_legs` ADD COLUMN `filled_notional_usd` decimal(24,8) NOT NULL DEFAULT 0;
```

- `migrations/meta/` is **not touched**: no `0002_snapshot.json` is added and `_journal.json` is updated only with the filename/tag entries that `drizzle-kit migrate` needs to pick the file up (verify against how 0002 was recorded; if the journal uses generated tags, mirror that format manually). The landmine is that generated *snapshot parity* cannot be trusted — a hand-written SQL + a minimal journal entry does not require snapshot regeneration. **Verify with `yarn db:migrate` on a scratch DB** that drizzle-kit applies it (fresh + existing DB).
- No new enum values; `DEFAULT 0` → no backfill.

**Writer deltas** (all via `TradeLegUpdate.filledNotionalUsdDelta?: string`, applied as `coalesce(col,0) + delta` inside each writer's existing transaction):

| Writer | Leg delta | Trade-level delta |
| --- | --- | --- |
| `db-preview-store.transition()` from `runEntry` | limit leg: `settledNotionalUsd`; hedge leg: `qty × hedge.averageFillPriceUsd` | sum of the two leg deltas (or a single `tradeNotionalUsdDelta` on `TransitionDetails`) |
| `trade-close.ts` step 2/3 | per leg: `qty × (ack.averageFillPriceUsd ?? position-derived exitPriceUsd)` (existing fallback) | sum of leg deltas |
| `trade-monitor.ts` venue-side closure | `qty × position.exitPriceUsd` (skip increment when exit price unknown) | same delta on `trades` |

Implementation in `db-preview-store.ts transition()`: extend `TransitionDetails` with `filledNotionalUsdDelta?: string` (trade) and per-leg `filledNotionalUsdDelta?: string`; apply with drizzle `sql` fragment: `tx.update(tradeLegs).set({ filledNotionalUsd: sql`coalesce(${tradeLegs.filledNotionalUsd}, 0) + ${delta}`})`. For `trade-close.ts` and `trade-monitor.ts` (which write through `transition()` / direct `tx.update` respectively): `trade-close` already funnels its final persistence through `store.transition(token, "closed", { legs: [...] })` → carry the deltas in those leg updates. `trade-monitor.ts` writes its own transaction → add the same `sql` fragment there.

**Why monotonic increments over a fill-event table**: no fill table exists; three writers already own transactions around exactly the moments volume is created; `coalesce + delta` is crash-safe by construction and idempotent under the recovery sweep (the stale-`closing` re-close path can re-apply a delta only if the first close's transition didn't commit — the pre-persist in step 2b makes that safe).

### D7. Volume-stats endpoint + web panel

**Backend** (`apps/backend`, mirroring balances routes):

- `exchanges/volume-stats-service.ts`: `VolumeStatsService` over `getDb()` with one method `getVolumeStats()` returning raw rows; SQL via drizzle:
  - lifetime: `select sum(trades.filled_notional_usd)`; per-venue lifetime: `select tradeLegs.exchangeId, sum(tradeLegs.filled_notional_usd) from tradeLegs group by exchangeId`.
  - trailing windows: same two queries with `where trades.updatedAt >= cutoff`. **Window filter pinned to `trades.updatedAt`** (last fill activity — every writer touches it), windows pinned to **24h / 7d / 30d** (spec left them open; these match common operator cadence and the dashboard's 30 s refresh is unrelated).
  - Caveat documented in the service: a trade opened 40 days ago that closed yesterday contributes to 24h volume — acceptable since the volume was *farmed* yesterday.
- `exchanges/volume-stats-normalizers.ts`: normalize to a response DTO (strings for decimals, per `formatDecimal` convention):

  ```json
  {
    "generatedAt": "ISO-8601",
    "lifetime": { "totalUsd": "1234.56", "byVenue": [{ "exchangeId": "risex", "volumeUsd": "..." }] },
    "windows": {
      "24h": { "totalUsd": "...", "byVenue": [...] },
      "7d":  { ... },
      "30d": { ... }
    }
  }
  ```

- `server.ts`: `app.get('/api/trades/volume-stats', asyncHandler(...))` registered alongside the balance routes; constructor gains a `volumeStats: VolumeStatsService` parameter (same injection pattern as `balances`). Read-only; no mutation routes.

**Web** (`apps/web/src/features/dashboard/`):

- `volume-stats.ts` fetch helper: `fetchVolumeStats(fetchImpl = fetch)` → `GET {VITE_BACKEND_API_BASE_URL}/api/trades/volume-stats`, reusing the `getBackendApiBaseUrl()` pattern from `exchange-balances.ts` (export/shared helper).
- `components/FarmedVolumePanel.tsx`: one component per file; displays lifetime total + 24h/7d/30d totals + per-venue breakdown; uses `MetricCard`/`SummaryItem`/`StatusBadge` and `dashboard-formatters.ts`; semantic tokens respected.
- `Dashboard.tsx`: fetch alongside balances inside the **existing 30 s refresh** (same interval/Effect, second promise); independent error/loading state so a backend outage degrades balances-only.
- **Empty-state / dry-run**: `filled_notional_usd` is `0` everywhere pre-fill → panel renders explicit zeros ("$0.00 farmed") rather than an error; mock-operations behavior is untouched (volume panel always shows real backend data — no mock needed, zeros are truthful in dry-run).

**Alternative considered**: separate refresh loop for the panel — rejected: two timers drift and double the request rate; one effect with `Promise.allSettled` keeps cadence identical to balances.

### D8. Config changes

`packages/config/src/index.ts`:

- Add a removed-vars guard at the top of `loadBotConfig`:

  ```ts
  const REMOVED_ENV_VARS = ["OPEN_TRADE_SPREAD_TP_USD", "OPEN_TRADE_SPREAD_SL_USD", "OPEN_TRADE_EDGE_MIN_PROFIT_USD"] as const;
  for (const key of REMOVED_ENV_VARS) {
    if (env[key] !== undefined) throw new Error(`${key} was removed by adjust-tpsl-volume-farming; see .env.example (spread exits deleted / replaced by OPEN_TRADE_MIN_PROFIT_USD)`);
  }
  ```

  Note: `loadBotConfig` has **no general unknown-var allowlist** (containers inject arbitrary env) — rejection is an explicit blocklist of the three removed vars, which is what the specs require.
- `openTrade.stopLossPercent` default `"3"` → `"2.5"`.
- Remove `spreadTpUsd`, `spreadSlUsd`, `edgeMinProfitUsd` from the interface and parsing.
- Add `minProfitUsd: parseNonNegativeDecimalString(env.OPEN_TRADE_MIN_PROFIT_USD ?? "0.05", ...)`, `maxLossUsd: parsePositiveDecimalString(env.OPEN_TRADE_MAX_LOSS_USD ?? "0.25", ...)`, `slippageBps: parseNonNegativeDecimalString(env.OPEN_TRADE_SLIPPAGE_BPS ?? "2", ...)`.
- Keep `spreadExitTimeoutMinutes` (env name unchanged per D5).

**Plumbing**: `BotConfig.openTrade.*` → `OpenTradeOptions` in `telegram-command-poller.ts openTradeService()` and `polling-loop.ts:106` (timeout minutes only; monitor inputs lose `spreadTpUsd`/`spreadSlUsd`/`edgeMinProfitUsd`); `formatActiveConfigSummary` drops the two spread lines and the edge line, adds `minProfitUsd`/`maxLossUsd`/`slippageBps`, updates the SL default; `.env.example` + `AGENTS.md` env table updated in the same PR.

**Fail-fast behavior**: removed vars throw at `loadBotConfig` before anything starts — intended BREAKING, error message names the replacement.

### D9. Verification approach (paused tests)

- `yarn typecheck` across all workspaces (covers `apps/bot/test/open-trade.test.ts` — `OpenTradeOptions` keeps `takeProfitPercent`/`stopLossPercent`; removed `edgeMinProfitUsd` must not be referenced there per explore.md; verify lines 117-118, 288-289 still compile, adjusting the test file's option literals *only* if they reference removed fields — allowed since the constraint is "compiles", not "unchanged").
- Dry-run evidence per spec scenario: (a) confirmed dry-run trade logs per-leg anchors + passing cross-symmetry within 100 bps; (b) a forced-tolerance breach (temporarily shrink tolerance via code constant in a scratch run) produces urgent notify + `failed` state, no protection orders; (c) fill with convergence below breakeven+$0.05 → `edge_below_cost` close + `edge_closed` Telegram edit; (d) spread move of any size before 30 min → no close; at 30 min → `spread_timeout` close; (e) `OPEN_TRADE_SPREAD_TP_USD=60 yarn dev:bot` → config error, no start; (f) after fills, `select filled_notional_usd from trades` grows at entry, close, and monitor paths; (g) `GET /api/trades/volume-stats` returns zeros on a fresh DB and consistent sums after trades; (h) dashboard renders panel, re-fetches at 30 s.

## Risks / Trade-offs

- [Mark-price vs last-price fills diverge by perp basis] → 3%/2.5% offsets dwarf basis; the 100 bps tolerance assertion quantifies residual asymmetry at protection time and is the live detector.
- [Position-average fallback re-introduces drift] → fallback only when order-ack read fails, and only past the integrity + tolerance checks; otherwise loud failure (urgent notify + `claimRollback`), never a silently mis-anchored order.
- [Fee bps drift from actual venue fees → miscomputed band] → `OPEN_TRADE_MAX_LOSS_USD` runtime assertion on the abort path empirically bounds the error and alerts the operator.
- [100 bps tolerance too tight on legitimate wide-spread fills → spurious protection failures] → 100 bps ≈ 1/3 of the smallest offset; a named constant (`PROTECTION_TOLERANCE_BPS = 100`) keeps it tunable without env churn.
- [Concurrent writers lose updates on one monotonic column] → `coalesce + delta` inside each writer's existing transaction; recovery sweep re-application is safe because deltas ride the same transition that the pre-persist (2b) already made idempotent.
- [Legacy env vars break an existing deployment at startup] → intended fail-fast with a clear error naming the replacement; `.env.example` + `/config` + AGENTS.md table document the new surface.
- [Migration drift] → hand-written additive `ALTER TABLE`s only, no enum changes, `DEFAULT 0` avoids backfill; `meta/` snapshots untouched; verified with `yarn db:migrate` on fresh + existing DBs.
- [Paused-test typecheck regression] → `OpenTradeOptions` keeps percent fields; `yarn typecheck` includes test files.
- [Multi-PR delivery (bot + backend + web) diverges] → chained PRs per sdd-tasks forecast: (1) config+DB+migration, (2) bot exit/anchoring/volume, (3) backend+web; each PR typechecks independently.

## Migration Plan

1. **Deploy order**: PR1 (config + schema + `0003_filled_notional_volume.sql`) → `yarn db:migrate` (applies additively; old code ignores the columns) → PR2 (bot) → PR3 (backend + web).
2. **Pre-deploy env update**: remove `OPEN_TRADE_SPREAD_TP_USD`, `OPEN_TRADE_SPREAD_SL_USD`, `OPEN_TRADE_EDGE_MIN_PROFIT_USD` from deployment env *before* PR2 rolls out (PR1 alone does not reject them — rejection ships with the config change; sequence env cleanup with PR2).
3. **Rollback**:
   - Code/config: revert commits; removed env vars return with the code.
   - DB: `ALTER TABLE trades DROP COLUMN filled_notional_usd; ALTER TABLE trade_legs DROP COLUMN filled_notional_usd;` — additive-only, safe in reverse; old code ignores the columns if rollback of the migration is delayed.
   - Behavioral: `OPEN_TRADE_MIN_PROFIT_USD` high restores veto-heavy behavior; spread-USD exit code is deleted (not flag-gated) — restoring it requires a code revert.
4. **Validation gates**: `yarn typecheck` green; dry-run evidence items (a)–(h) from D9; migration applies on fresh and existing DBs with zero rows changed.

## Open Questions

1. Does the RISEx order-status/read endpoint reliably return an average fill price for market orders, or only the ack? If only the ack, the fallback frequency rises and the integrity check carries more weight — to be confirmed against `docs/exchanges/risex-integration.md` during implementation (D2).
2. Exact `migrations/meta/_journal.json` entry format for a hand-written 0003 — mirror 0002's record manually; confirm `yarn db:migrate` picks it up on a scratch DB (D6).
3. Should `/summary` keep its live-price "Total notional" estimate alongside the new DB-backed farmed-volume line? Spec says "replacing or augmenting" — recommendation: keep both, labeled distinctly; final wording at implementation.
4. Trailing-window filter on `trades.updatedAt` vs `openedAt` — pinned to `updatedAt` here (volume is farmed at write time); confirm no spec reviewer objects during tasks phase.
