# Proposal — adjust-tpsl-volume-farming

## Why

The open-trade execution flow is not oriented around the bot's primary objective — **farming trading volume**. Spread-USD exits and a dormant, informational-only fill-time edge check let trades fill at net-negative edges, while the user-observed ±15% drift between entry and TP/SL levels (traced in `explore.md` to cross-anchored protection orders, position-average "fill prices", and wick-prone LAST triggers) means protection is routinely mis-anchored. Meanwhile the farmed volume — the metric the strategy exists to produce — is not persisted anywhere and never surfaces in Telegram. This change fixes the exit/anchoring model and makes farmed volume a first-class, persisted, operator-visible quantity.

## What Changes

- **Replaces spread-USD exits with per-leg percentage exits only** — TP 3% / SL 2.5% (SL default changed from 3), anchored to each leg's *actual* fill price; the spread exit monitor keeps only the orthogonal 30-minute time-stop (timeout) close and the stale-`closing` recovery sweep (possible rename to reflect timeout-only role). **BREAKING**: `OPEN_TRADE_SPREAD_TP_USD` and `OPEN_TRADE_SPREAD_SL_USD` are removed and rejected by config loading.
- **Fixes the ±15% TP/SL drift** by anchoring each leg's protection orders to that leg's own fill price (replacing the current cross-anchor where the short leg inherits the long leg's `longSl`/`longTp` in `open-trade.ts` `runEntry()`), preferring the true fill price over the RISEx whole-position `avg_entry_price` (`risex-execution-adapter.ts` `readPositionEntryPrice`) with loud failure on corrupt/blended values, adding a tolerance assertion (100 bps) and a cross-symmetry check so mis-anchored protection fails loudly, and using `MARK_PRICE` trigger price type on RISEx (`stop_price_option: MarkPrice`, per `docs/exchanges/risex-integration.md:44`) while Extended stays LAST-only (150 bps `MARKET_CROSSING_BUFFER_BPS` bound).
- **Introduces a fee-aware fill-time edge band** replacing the informational-only `evaluateCapturedEdge` check: keep the trade iff expected convergence ≥ round-trip breakeven (entry + exit fees + `OPEN_TRADE_SLIPPAGE_BPS` slippage) + `OPEN_TRADE_MIN_PROFIT_USD` ($0.05 default); otherwise immediately reduce-only close both legs via the existing `closeTradeBothLegs` path (reason `edge_below_cost` already exists) with realized loss ≈ fees ≪ `OPEN_TRADE_MAX_LOSS_USD` ($0.25), and reactivate the dormant `edge_closed` `ConfirmOutcome` return path in `telegram-command-poller.ts:479-559`. **BREAKING**: `OPEN_TRADE_EDGE_MIN_PROFIT_USD` (default 10) is **replaced, not aliased**, by `OPEN_TRADE_MIN_PROFIT_USD`; deployments still setting the old var fail fast at `loadBotConfig`.
- **Persists farmed volume**: new `filled_notional_usd decimal(24,8) not null default 0` columns on `trades` (required) and `trade_legs` (recommended), accumulated monotonically (`coalesce(col,0) + delta`) inside the existing transactions of the three existing writers — `db-preview-store.transition()`/`runEntry` (limit-leg `settledNotionalUsd`; hedge-leg `qty × hedge.averageFillPriceUsd`), `trade-close.ts` (close fills `qty × ack.averageFillPriceUsd`), `trade-monitor.ts` (venue-side TP/SL closures `qty × exitPrice`) — via hand-written migration `packages/db/migrations/0003_*.sql` (no `drizzle-kit generate`, no new enum values).
- **Surfaces farmed volume in Telegram**: new volume line in the fill summary (`buildFillSummary`), cumulative-volume line in the close notice, and a DB-backed lifetime/period farmed-volume line in `/summary` (`trade-summary.ts`).
- **Config surface updates** (`packages/config/src/index.ts`, `.env.example`, `AGENTS.md` env table, `/config` echo in `formatActiveConfigSummary`): `OPEN_TRADE_STOP_LOSS_PERCENT` default → `2.5`; new `OPEN_TRADE_MIN_PROFIT_USD` (`0.05`), `OPEN_TRADE_MAX_LOSS_USD` (`0.25`, enforced as a runtime assertion on the abort-close path), `OPEN_TRADE_SLIPPAGE_BPS` (`2`, replacing the `EXIT_SLIPPAGE_BPS` constant at `open-trade.ts:78`); keep `OPEN_TRADE_SPREAD_EXIT_TIMEOUT_MINUTES` (`30`).
- **Adds a read-only volume-stats API and dashboard panel (DP6, in scope per user decision 2026-09-17):** new `GET /api/trades/volume-stats` in `apps/backend` (read-only, same pattern as balances routes: service + normalized response), and a farmed-volume panel in the `apps/web` dashboard fed by `VITE_BACKEND_API_BASE_URL` with the existing 30 s refresh cadence. No mutation endpoints; backend stays read-only.
- **Docs/specs**: `AGENTS.md` env table, `specs/bot.md` spread-exit wording, `specs/backend.md` + `specs/web.md` new stats route/panel wording, `docs/exchanges/risex-integration.md` trigger-source note.
    
**Non-goals (unchanged even if related):** no auto-trading changes (order authority stays bot-only via Telegram confirmation; exits remain reduce-only); no re-enabling/adding of unit tests (verification is `yarn typecheck` + dry-run evidence; `apps/bot/test/open-trade.test.ts` lines 117-118, 288-289 must keep compiling under `tsc`); no execution-gate semantic changes (`BOT_EXECUTION_MODE` / `ENABLE_ORDER_PLACEMENT` display-vs-gate distinction stays); no new enum values; no `drizzle-kit generate`; no changes to signal suppression, the polling-loop `continue` quirk, or other recorded landmines.

## Capabilities

### New Capabilities

- `trade-exits`: Per-leg percentage TP/SL (3% / 2.5%) anchored to each leg's true fill price, with a tolerance assertion (100 bps) and cross-symmetry check at the protection step, per-venue trigger price type (MARK_PRICE on RISEx, LAST on Extended), and loud failure on corrupt/blended fill prices; removal of spread-USD exits (env vars deleted, config-load rejection) while retaining the time-stop and stale-`closing` recovery sweep; fee-aware fill-time edge band (breakeven + `OPEN_TRADE_MIN_PROFIT_USD` keep, else immediate reduce-only abort within the `OPEN_TRADE_MAX_LOSS_USD` band) with the `edge_closed` outcome reactivated.
- `volume-farming`: Persistence of farmed volume as `filled_notional_usd` on `trades` and `trade_legs`, accumulated monotonically (`coalesce + delta`) at the three existing DB writers (`db-preview-store.transition()`, `trade-close.ts`, `trade-monitor.ts`) inside their current transactions; hand-written additive migration `0003_*.sql` (no generated diffs, no new enums, `DEFAULT 0` backfill-free); farmed-volume lines surfaced in the Telegram fill summary, close notice, and `/summary` command.
- `volume-stats-api`: Read-only `GET /api/trades/volume-stats` endpoint in `apps/backend` (service + normalizer pattern identical to the balances routes; totals plus per-venue breakdown, lifetime and trailing-window aggregations read from `trades`/`trade_legs`), consumed by a farmed-volume panel in the `apps/web` dashboard via `VITE_BACKEND_API_BASE_URL` on the existing 30 s refresh; no mutation routes, no exchange signing logic in web.

### Modified Capabilities

<none — `openspec/specs/` is empty; all capabilities above are new>

## Impact

- **Bot trading core** (`apps/bot/src/trading/open-trade.ts`, `spread-exit-monitor.ts`, `trade-close.ts`, `trade-monitor.ts`, `db-preview-store.ts`) — exit-model semantics, protection anchoring, edge gate, volume writes.
- **Exchange execution** (`apps/bot/src/exchanges/risex/risex-execution-adapter.ts`; Extended adapter untouched except trigger-bound awareness) — trigger price type, fill-price integrity.
- **Config surface** (`packages/config/src/index.ts`, `.env.example`, `AGENTS.md` table, `/config` echo) — removed/added vars; deployments setting removed vars fail fast at config load (intended).
- **Database** (`packages/db/src/schema.ts` + `packages/db/migrations/0003_*.sql`) — additive columns only.
- **Runtime/operator wiring** (`apps/bot/src/runtime/polling-loop.ts`, `apps/bot/src/notifications/telegram-command-poller.ts`, `apps/bot/src/notifications/trade-summary.ts`) — config plumbing, volume notices.
- **Backend API** (`apps/backend/src/server.ts` + `exchanges/` pattern: new stats service reading `trades`/`trade_legs`) — read-only volume-stats route.
- **Web dashboard** (`apps/web/src/features/dashboard/`: new panel component + fetch helper following the balances pattern) — farmed-volume display on the 30 s refresh.
- **Specs/docs** — `specs/bot.md`, possibly `docs/exchanges/risex-integration.md` and `docs/architecture.md` if exit wording appears.

**Risks and mitigations:**

| Risk | Mitigation |
| --- | --- |
| Mark-price triggers on RISEx diverge from last-price fills by basis → TP fires "late/early" vs expectation | Both venues track the same BTC; 3%/2.5% offsets dwarf perp basis; tolerance assertion quantifies residual asymmetry at protection time |
| True-fill price unavailable for the RISEx hedge in some path → fallback to position average re-introduces drift | Fallback kept but loud: corrupt/blank `avg_entry_price` or signed-size fallback now fails the protection step (urgent notify + rollback) instead of placing mis-anchored orders |
| Fee bps inputs (`options.fees`) drift from actual venue fees → breakeven band miscomputed | `OPEN_TRADE_MAX_LOSS_USD` runtime assertion on abort closes empirically bounds the error and alerts the operator |
| Tolerance assertion too tight (100 bps) → spurious protection failures on legitimate wide-spread fills | 100 bps ≈ 1/3 of the smallest (2.5%) offset; configurable constant if it proves noisy in dry-run evidence |
| Multiple writers incrementing one monotonic column → lost updates | Increments use `coalesce + delta` inside the writers' existing transactions (crash-safe by construction) |
| Removing `OPEN_TRADE_EDGE_MIN_PROFIT_USD` / spread vars breaks an existing `.env` | `loadBotConfig` fails fast with a clear unknown-var error — intended; `.env.example` and `/config` echo document the new surface |
| Migration drift: generated SQL mismatch | Hand-written `0003_*.sql`, additive `ALTER TABLE` only, no enum changes, `DEFAULT 0` avoids backfill |
| Typecheck regression in paused tests | `OpenTradeOptions` changes keep `apps/bot/test/open-trade.test.ts` compiling; `yarn typecheck` covers test files |

**Rollback:**

- **Code/config:** revert the change commit; the removed env vars return with it. Until re-migrated down, the DB simply carries two unused additive columns (harmless).
- **Migration rollback:** `ALTER TABLE trades DROP COLUMN filled_notional_usd; ALTER TABLE trade_legs DROP COLUMN filled_notional_usd;` — additive-only, no data transformation, safe to apply in reverse while old code ignores the columns.
- **Behavioral rollback:** defaults are env-driven; setting `OPEN_TRADE_MIN_PROFIT_USD` high restores veto-heavy behavior if needed (though spread-USD exit code is deleted, not flag-gated — restoring it requires a code revert).

**Success criteria:**

1. `yarn typecheck` passes across all workspaces.
2. On a dry-run-confirmed trade, TP = per-leg fill × 1.03 and SL = per-leg fill × 0.975, each anchored to that leg's own fill; the tolerance assertion passes and the cross-symmetry check (short SL ≈ long TP level, short TP ≈ long SL level within 100 bps) is logged.
3. A fill whose expected convergence < round-trip breakeven + $0.05 is closed immediately reduce-only (reason `edge_below_cost`) with realized loss ≪ $0.25, and the Telegram `edge_closed` notice fires via the reactivated outcome path.
4. No spread-USD comparisons run anywhere (time-stop and recovery sweep intact); `OPEN_TRADE_SPREAD_TP_USD` / `OPEN_TRADE_SPREAD_SL_USD` are rejected by config loading.
5. `trades.filled_notional_usd` and `trade_legs.filled_notional_usd` accumulate entry + hedge + close notional across all three writers; the Telegram fill summary, close notice, and `/summary` show farmed volume.
6. RISEx TP/SL orders use `MARK_PRICE` triggers; a corrupt/blended hedge fill price fails loudly rather than producing ±15% triggers.
7. Migration 0003 applies cleanly on a fresh and on an existing database; no enum values are added.
8. `GET /api/trades/volume-stats` returns lifetime and trailing-window farmed volume with a per-venue breakdown from the DB (read-only; no mutation routes), and the web dashboard renders the farmed-volume panel refreshed on the existing 30 s cadence.

## Appendix — Decision points and recommendations (DP1–DP6)

### DP1 — Exit model: standing TP/SL orders + fee-aware band (D1/D2/D4 reconciliation)

**Decision.** The two-layer model is the reconciliation of confirmed decisions D1 (per-leg percent exits only), D2 (dynamic fee-based edge goals), and D4 (net band TP ≥ breakeven + $0.05; abort ≤ breakeven − $0.25):

- **Layer 1 — fill-time edge evaluation (dynamic, fee-aware).** At fill time, compute `breakevenUsd = entryFees + exitFees + slippageEstimate` from `options.fees` (maker bps for the limit leg, taker bps for the market leg) × per-leg filled notional, plus `OPEN_TRADE_SLIPPAGE_BPS` (default 2) on exit notional. Keep the trade iff `expectedConvergenceUsd ≥ breakevenUsd + OPEN_TRADE_MIN_PROFIT_USD` ($0.05). Otherwise immediately reduce-only close both legs via the existing `closeTradeBothLegs` path (reason `edge_below_cost` already exists); the realized loss is ≈ fees + slippage, structurally far below the `OPEN_TRADE_MAX_LOSS_USD` ($0.25) band. Reactivate the existing-but-dormant `edge_closed` `ConfirmOutcome` return path in `telegram-command-poller.ts:479-559` — `runEntry` never returns it today; no new outcome plumbing is needed.
- **Layer 2 — standing venue TP/SL orders (static percentages).** TP = fill × 1.03, SL = fill × 0.975 per leg, submitted as reduce-only `take-profit-market` / `stop-market` as today. These govern normal exits while the trade is open. The 2.5% SL is the catastrophic backstop (on a $100 notional leg ≈ $2.50, still bounded and rare); it is *not* the farming exit — the time-stop and the Layer-1 band do that work.

**Why this reconciles D1 with D2/D4 without contradiction.** D1's standing orders and D2/D4's dynamic band operate at different moments and on different quantities: the band is a one-shot gate evaluated once at fill (expected convergence vs round-trip cost); the standing orders persist at the venue for the life of the trade (per-leg price moves vs per-leg fill). The band protects the farming objective at the only moment the information is knowable; the standing orders protect each leg from adverse moves while volume accrues. The cross-symmetry requirement (SL of short ≈ TP of long and vice versa) holds because both legs are anchored to their own real fills of the same BTC on two venues tracking one price — per-leg anchoring ≈ symmetric levels within spread tolerance, which the new tolerance assertion verifies explicitly.

**Recommendation: adopt this two-layer model as stated.** It is implementable entirely with existing machinery (no new order types, no new close paths).

### DP2 — `OPEN_TRADE_EDGE_MIN_PROFIT_USD` (current default 10): replace vs alias

**Decision.** `OPEN_TRADE_EDGE_MIN_PROFIT_USD` defaults to `"10"` — a $10 minimum edge on a $100 notional trade directly contradicts the cents-level farming objective and would veto nearly every desirable fill.

**Recommendation: replace, do not alias.** Remove `OPEN_TRADE_EDGE_MIN_PROFIT_USD` and the `edgeMinProfitUsd` option; introduce `OPEN_TRADE_MIN_PROFIT_USD` (default `"0.05"`) as the single knob layered on the round-trip breakeven. Aliasing (keeping the old var as an override) preserves the dead $10 semantic, doubles the config surface, and invites the exact misconfiguration this change exists to remove. Any deployment still setting the old var will get a clear config error at `loadBotConfig` rather than silently farming with a vetoing threshold. Update `formatActiveConfigSummary` and `.env.example` accordingly.

### DP3 — New/changed env vars and defaults

Mirror the existing plumbing pattern: `loadBotConfig(env)` parses/validates (`parsePositiveDecimalString` / `parseNonNegativeDecimalString`) → `BotConfig.openTrade.*` → wired in `telegram-command-poller.ts openTradeService()` and `polling-loop.ts:106` → echoed in `formatActiveConfigSummary` → documented in `.env.example` and the `AGENTS.md` env table.

| Variable | Action | Default | Purpose |
| --- | --- | --- | --- |
| `OPEN_TRADE_STOP_LOSS_PERCENT` | change default | `2.5` (was `3`) | Per-leg catastrophic SL |
| `OPEN_TRADE_MIN_PROFIT_USD` | new (replaces `OPEN_TRADE_EDGE_MIN_PROFIT_USD`) | `0.05` | Min edge above round-trip breakeven to keep a fill |
| `OPEN_TRADE_MAX_LOSS_USD` | new | `0.25` | Max-loss band for the fill-time abort close (assertion/guard, not a hard order) |
| `OPEN_TRADE_SLIPPAGE_BPS` | new (replaces `EXIT_SLIPPAGE_BPS` constant `open-trade.ts:78`) | `2` | Estimated exit slippage in the breakeven computation |
| `OPEN_TRADE_SPREAD_TP_USD` | remove | — | Spread-USD exits deleted (D1) |
| `OPEN_TRADE_SPREAD_SL_USD` | remove | — | Spread-USD exits deleted (D1) |
| `OPEN_TRADE_SPREAD_EXIT_TIMEOUT_MINUTES` | keep (default `30`) | `30` | Time-stop retained; monitor may be renamed to reflect timeout-only role |

**Recommendation: adopt the table as-is.** One open sub-choice: whether `OPEN_TRADE_MAX_LOSS_USD` should be enforced as a runtime assertion on the immediate-close path (log/notify if the realized abort loss exceeds it) in addition to documenting the band. Recommendation: yes — cheap, and it validates the fee model empirically.

### DP4 — ±15% drift root-cause fix: per-leg anchoring, tolerance assertion, trigger price type

**Decision.** Three coordinated fixes, per `explore.md`:

1. **Per-leg fill anchoring.** Each leg's TP/SL derive from *that leg's own* fill price (`longEntry` for the long leg, `shortEntry` for the short leg), replacing the current cross-anchor where the short leg inherits `longSl`/`longTp`. Cross-symmetry is then *verified*, not assumed.
2. **Fill-price integrity for the RISEx hedge.** The RISEx hedge "fill" currently comes from `readPositionEntryPrice` (whole-position `avg_entry_price`, blended with any residual position) — candidate root cause #1. Where a true fill price is available from the order ack it must be preferred; the position-average path remains only as a documented fallback, and a blended/corrupt value (`avg_entry_price: ""`, signed-size fallback) must fail the protection step rather than silently produce ±15% triggers.
3. **Tolerance assertion at the protection step.** After computing TP/SL, assert each trigger is within a small tolerance (recommend **100 bps** of the expected `fill × (1 ± p)` level, i.e., roughly 1/3 of the smallest offset) and that the two legs' trigger levels satisfy the cross-symmetry check within the same tolerance. Breach → do not place protection; treat as an execution failure (urgent notify + rollback/`failed` handling), never as a silently mis-anchored order. This assertion also serves as the live detector for which drift candidate is still firing.

**Trigger price type sub-decision.** RISEx supports `MARK_PRICE` (`stop_price_option`, per `docs/exchanges/risex-integration.md:44`); Extended is LAST-only with a 150 bps execution bound past the trigger (`MARKET_CROSSING_BUFFER_BPS`). LAST triggers on thin venues fire on wicks — consistent with exits observed at ±15% from entry (candidate #2).

**Recommendation: use `MARK_PRICE` triggers on RISEx** (`stop_price_option: MarkPrice` in the TP/SL payload), keep LAST on Extended (no alternative exists; the 150 bps bound limits wick damage). Asymmetric trigger sources across venues are acceptable: both venues track the same BTC mark within normal basis, and the tolerance assertion quantifies any residual asymmetry. If the operator prefers uniform semantics, LAST-on-both remains viable — but MARK on RISEx is the strictly safer default for stop integrity and is a config-level constant change in `risex-execution-adapter.ts`.

### DP5 — Volume schema and aggregation

**Decision.** Persist farmed volume as filled notional (USD) per leg fill (entry + hedge + any TP/SL/timeout/abort closes), summed per trade. There is no fill-event table; aggregation happens monotonically at the three existing writers inside their current transactions (crash-safe):

- `db-preview-store.ts transition()` / `runEntry` fill loop — limit-leg `settledNotionalUsd` (already exact across reprices); hedge-leg `qty × hedge.averageFillPriceUsd`.
- `trade-close.ts` — close fills `qty × ack.averageFillPriceUsd` (with the existing position-derived exit-price fallback in step 3).
- `trade-monitor.ts` — venue-side TP/SL closures, where only exit price is known: increment = `qty × exitPrice`.

**Recommended columns** (money columns are `decimal(24,8)` per convention):

- `trades.filled_notional_usd decimal(24,8) not null default 0` — **required**; cumulative per-trade farmed volume, the basis for the Telegram summary and the future endpoint.
- `trade_legs.filled_notional_usd decimal(24,8) not null default 0` — **recommended**; per-leg granularity for debugging drift/anchoring issues and per-venue volume splits.

Writers use monotonic increments (`filled_notional_usd = coalesce(filled_notional_usd, 0) + :delta`) so concurrent/crashy paths cannot lose volume.

**Migration.** Hand-written `packages/db/migrations/0003_*.sql` (`ALTER TABLE ... ADD COLUMN` for both columns). **Do not use `drizzle-kit generate`** — per the migration-drift landmine (`AGENTS.md`), `migrations/meta/` has no `0001_snapshot.json` and generated diffs cannot be trusted for parity. **No new enum values** on `trades.status` / `trade_legs.status` (the `trade_status_history` width mismatch would bite). `DEFAULT 0` keeps the write backfill-free; existing rows simply read as zero volume.

### DP6 — Web dashboard volume endpoint: IN SCOPE (user decision 2026-09-17)

The pre-proposal recorded D3 as contradictory (dashboard endpoint marked both "yes" and "DB only for now"). **Resolved at proposal approval: the read-only volume-stats endpoint and the web dashboard panel are IN SCOPE for this change** — backend `GET /api/trades/volume-stats` (same service/normalizer pattern as balances routes) plus a farmed-volume panel in the web dashboard on the existing 30 s refresh. Consequence: this change spans bot + backend + web, and the sdd-tasks Review Workload Forecast will likely recommend chained PRs over the 400-line budget; delivery strategy will be resolved at that gate.

### Proposal question round — RESOLVED at approval (2026-09-17)

1. **DP6 / web endpoint:** **RESOLVED — IN SCOPE.** Backend read-only stats endpoint + web dashboard panel ship in this change.
2. **DP2:** **RESOLVED — replace** (not alias) `OPEN_TRADE_EDGE_MIN_PROFIT_USD` with `OPEN_TRADE_MIN_PROFIT_USD`; fail-fast at config load is intended.
3. **DP4:** **RESOLVED — MARK_PRICE triggers on RISEx** (LAST-only on Extended) and **100 bps** protection tolerance as the loud-failure threshold.
4. **DP5:** **RESOLVED — confirmed** both volume columns (`trades.filled_notional_usd` required, `trade_legs.filled_notional_usd` for per-leg granularity) and the hand-written migration 0003 approach.
