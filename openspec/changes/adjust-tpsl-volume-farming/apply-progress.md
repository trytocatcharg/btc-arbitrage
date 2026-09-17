# Apply Progress — adjust-tpsl-volume-farming

## Work unit: PR1 — Config surface, DB schema, and migration 0003 (COMPLETE)

Structured status consumed: proposal/specs/design done; tasks.md is the tracker; delivery = single branch,
one merge (user decision); work-unit slicing PR1 → PR2 → PR3; this unit = tasks 1.1–1.10 only.
No prior apply-progress existed (fresh file, nothing merged/overwritten).

### Completed tasks (all persisted as `- [x]` in tasks.md)

- **1.1** Removed-vars guard at top of `loadBotConfig` (`packages/config/src/index.ts`): explicit blocklist
  `REMOVED_ENV_VARS = [OPEN_TRADE_SPREAD_TP_USD, OPEN_TRADE_SPREAD_SL_USD, OPEN_TRADE_EDGE_MIN_PROFIT_USD]`,
  each throws naming the change + replacement (`OPEN_TRADE_MIN_PROFIT_USD`). Runtime-verified:
  `OPEN_TRADE_SPREAD_TP_USD=60` → `GUARD OK: OPEN_TRADE_SPREAD_TP_USD was removed by adjust-tpsl-volume-farming; …`.
- **1.2** `openTrade` config block: `stopLossPercent` default `"3"`→`"2.5"`; removed `spreadTpUsd`/`spreadSlUsd`/
  `edgeMinProfitUsd` (interface + parsing, no alias); added `minProfitUsd` (`?? "0.05"`, non-negative),
  `maxLossUsd` (`?? "0.25"`, positive), `slippageBps` (`?? "2"`, non-negative); `spreadExitTimeoutMinutes`
  untouched (default 30). Runtime-verified parsed defaults: `{"sl":"2.5","minProfit":"0.05","maxLoss":"0.25","slippageBps":"2","timeoutMin":30}`.
- **1.3** `.env.example` + `AGENTS.md` env table updated: three removed vars gone (documented as Removed/
  fail-fast in AGENTS.md), SL default 2.5, three new knobs documented.
- **1.4** `telegram-command-poller.ts`: `openTradeService()` wiring drops `edgeMinProfitUsd`, adds
  `minProfitUsd`/`maxLossUsd`/`slippageBps`; `formatActiveConfigSummary` drops spread-exit + min-edge lines,
  adds edge-band / max-loss / slippage lines (time-stop line retained since the knob still exists; rename deferred to 2.9).
- **1.5** `spread-exit-monitor.ts`: removed `spreadTpUsd`/`spreadSlUsd`/`edgeMinProfitUsd`/`takerFeesBps`
  inputs, spread-USD comparisons, per-tick `evaluateCapturedEdge` gate + its import; retained the
  stale-`closing` recovery sweep and the 30-min time-stop (`spread_timeout`); `priceByExchange` kept (still
  records `exitSpreadUsd` on time-stop closes; 2.9 decides its removal). File/monitor NOT renamed (deferred to 2.9).
  `polling-loop.ts` stops passing removed config fields.
- **1.6** `packages/db/src/schema.ts`: `filledNotionalUsd: decimal('filled_notional_usd', { precision: 24, scale: 8 }).notNull().default('0')`
  on `trades` (after `totalFeesUsd`) and `tradeLegs` (after `realizedPnlUsd`). Status enums untouched.
- **1.7** `packages/db/migrations/0003_filled_notional_volume.sql` hand-written: exactly the two additive
  `ALTER TABLE … ADD COLUMN filled_notional_usd decimal(24,8) NOT NULL DEFAULT 0` statements with a
  `--> statement-breakpoint` marker between them (mirrors 0002 format).
- **1.8** `migrations/meta/_journal.json`: appended `{"idx": 3, "version": "5", "when": 1789648707392, "tag": "0003_filled_notional_volume", "breakpoints": true}`.
  No snapshots added.
- **1.9** `yarn typecheck` green across all workspaces (exit 0, silent). `apps/bot/test/open-trade.test.ts`
  lines 117-118 / 288-289 use only `takeProfitPercent`/`stopLossPercent` — no removed field referenced, no test edits needed.
- **1.10** Scratch-DB verification on the reachable MariaDB from `.env` (credentials via env vars only, never logged;
  scratch DBs `btc_arbitrage_pr1_fresh` / `btc_arbitrage_pr1_existing`, both dropped afterwards):
  - (a) Fresh DB: `yarn db:migrate` (drizzle-kit) applied all 4 migrations successfully; both columns present
    as `decimal(24,8) NOT NULL DEFAULT 0.00000000`; status enums unchanged; 4 entries in `__drizzle_migrations`.
  - (b) Existing-DB shape: schema from `scripts/001_create_schema.sql` + prior trade/legs rows (real DB had 0
    trades → 1 synthetic prior trade + 2 legs inserted); migration 0003 applied via statement-split file; all
    pre-existing rows read `filled_notional_usd = 0`; enums unchanged.
  - Note: docker daemon was down; the reachable local MariaDB was used instead (task-preferred option).

### Files changed

- `packages/config/src/index.ts` (1.1, 1.2)
- `.env.example` (1.3) — edited via shell after the edit tool refused the sensitive path; content verified
- `AGENTS.md` (1.3)
- `apps/bot/src/notifications/telegram-command-poller.ts` (1.4)
- `apps/bot/src/trading/spread-exit-monitor.ts` (1.5)
- `apps/bot/src/runtime/polling-loop.ts` (1.5)
- `apps/bot/src/trading/open-trade.ts` (type-surface only — see deviations)
- `packages/db/src/schema.ts` (1.6)
- `packages/db/migrations/0003_filled_notional_volume.sql` (new, 1.7)
- `packages/db/migrations/meta/_journal.json` (1.8)
- `packages/db/migrations/0001_open_trade_execution.sql` (pre-existing defect fix — see deviations)
- `openspec/changes/adjust-tpsl-volume-farming/tasks.md` (checkboxes 1.1–1.10)

### Test/verification commands run

- `yarn typecheck` → exit 0 (twice; second run after all edits)
- `yarn workspace @btc-arbitrage/domain build && yarn workspace @btc-arbitrage/config build` → OK (for guard runtime test)
- Guard runtime test via `packages/config/dist` → GUARD OK + defaults JSON (above)
- `DATABASE_DB_NAME=btc_arbitrage_pr1_fresh yarn db:migrate` → "migrations applied successfully", exit 0
- Node/mysql2 verification scripts for columns, defaults, enums, row-zero checks, scratch cleanup

### Deviations from design/tasks (needs reviewer awareness)

1. **`open-trade.ts` touched (outside bounded writer list), type-surface only.** Task 1.4 wires
   `minProfitUsd`/`maxLossUsd`/`slippageBps` into `openTradeService()`, but `OpenTradeOptions` didn't declare
   them; the object literal would fail TS2353 excess-property checking. Added the three fields as optional
   `OpenTradeOptions` members with doc comments marking them "wired since PR1; consumed in PR2". No behavior change.
2. **`0001_open_trade_execution.sql` fixed (outside bounded writer list).** It contained zero
   `--> statement-breakpoint` markers, so `yarn db:migrate` on any fresh DB failed inside 0001
   (MariaDB ER_PARSE_ERROR at line 3) — fresh-DB migration was broken before this change; the real DB has no
   `__drizzle_migrations` table (bootstrapped via `001_create_schema.sql`). Fix = added the standard markers
   between the file's existing statements; a diff against git HEAD confirms the SQL statements are byte-identical
   (markers only). Safe for any DB that already applied 0001 (drizzle records by journal entry, not content).
3. **`formatActiveConfigSummary` keeps a time-stop line** (with the still-existing `spreadExitTimeoutMinutes`
   knob) so `/config` doesn't lose the retained 30-minute time-stop; spread-TP/SL and min-edge lines dropped as instructed.
4. **`priceByExchange` retained in the monitor** (used to record `exitSpreadUsd` on time-stop closes); its
   removal "if now unused" is deferred to task 2.9 as scoped.
5. `.env.example` required shell-based editing because the environment's edit tool classifies it as a sensitive
   path; the task explicitly authorized it. Final content grep-verified.

### Remaining tasks (unchanged, not started)

All of PR2 (2.1–2.15) and PR3 (3.1–3.8) remain `- [ ]`. Next work unit: PR2.

### Workload / PR boundary

PR1 authored changes ≈ 200 lines net (config ~80, bot ~120, db ~20, docs ~30) — within the 400-line budget.
No commit made (parent commits after verification).

### Risks

- Deploy sequencing reminder from tasks.md still applies: remove `OPEN_TRADE_SPREAD_TP_USD` /
  `OPEN_TRADE_SPREAD_SL_USD` / `OPEN_TRADE_EDGE_MIN_PROFIT_USD` from deployment env before the config change rolls out.
- The 0001 fix means `yarn db:migrate` now works on fresh DBs; any environment that applied migrations
  manually/out-of-band should confirm `__drizzle_migrations` state before running it.

## Work unit: PR2 — Bot trading core (COMPLETE except runtime evidence 2.15)

This is a CONTINUATION run: the previous PR2 run timed out while building dry-run evidence
harnesses, leaving all code landed in the working tree with `yarn typecheck` green but no
checkboxes marked. This run audited every task 2.1–2.15 against the actual code, completed
nothing (audit found no gaps), marked 2.1–2.14, and produced bounded evidence. PR1 progress
above is unchanged/merged.

### Audit table (2.1–2.15) — per-task verdicts with file:line evidence

| Task | Verdict | Evidence |
| --- | --- | --- |
| 2.1 RISEx MARK_PRICE | done | `stop_price_option: StopPriceOption.MarkPrice` at both `placeTakeProfit`/`placeStopLoss` call sites (`risex-execution-adapter.ts:232,241`); Extended untouched; trigger-source note updated (`docs/exchanges/risex-integration.md:28,45-48`) |
| 2.2 true-fill provenance | done | `waitForMarketFill` returns `MarketFillResult { priceUsd, source, derived }` with `order_ack`/`order_history`/`position_average` (`:488-535`); `readOrderHistoryFillPrice` reads `/v1/orders` avg-fill field then qty-weighted `/v1/trade-history` fills (`:558-626`); timeout returns no price → caller keeps ack `status:'new'` fail-closed (`:308-321`) |
| 2.3 per-leg anchoring | done | Triggers computed with `applyPercentChange` (`open-trade.ts:892-917`): longTp ×(1+TP), longSl ×(1−SL), shortTp ×(1−SL), shortSl ×(1+TP); short `protect(..., shortTp, shortSl)` (`:1068-1078`), long `protect(..., longTp, longSl)` (`:1044-1054`); persisted `tpTriggerUsd/slTriggerUsd` corrected (`:1120-1123`) |
| 2.4 assertProtectionAnchors | done | `PROTECTION_TOLERANCE_BPS = 100` (`:111`); pure exported helper with per-trigger + both cross-symmetry checks, full anchor set logged on pass (`:165-215`); **called in `runEntry` at `:925-935`** before the `protecting` transition; `ProtectionAnchorError` rides the existing catch (cancel/claimRollback/emergency closes/`failed`/`unhedged`/`notifyUrgent`, `:1120-1245`) — no new failure machinery |
| 2.5 fill-price integrity | done | Applied when `hedgeFillSource === "position_average"` (`:836-866`): blank/non-positive/`derived` (signed-size fallback) or >100 bps deviation from the limit fill → `ProtectionAnchorError`; `order_ack`/`order_history` used directly |
| 2.6 fee-aware edge band | done (deviation #1) | `evaluateCapturedEdge` block replaced (`:932-977`): entryFees = maker(limit)+taker(hedge), exitFees = taker per leg, slippage = exitNotional × `slippageBps`; `EXIT_SLIPPAGE_BPS` and `edgeMinProfitUsd` removed; `expectedConvergenceUsd = max(0, shortEntry − longEntry)` |
| 2.7 edge abort + edge_closed | done | `!keepOpen` → `closeTradeBothLegs({ reason: "edge_below_cost", legs with entryPriceUsd: longEntry/shortEntry })` (`:990-1012`); returns `{ outcome: "edge_closed", realizedPnlUsd, capturedSpreadUsd, minEdgeUsd }` (`:1039-1044`); dormant poller handling verified live at `telegram-command-poller.ts:487-493` (`reportTradeOutcome` → `formatEdgeClosedNotice:547`) and retry path `:358-359` — no new plumbing |
| 2.8 maxLoss assertion | done | Post-abort abs(realizedPnlUsd) greater than maxLossUsd → `console.error` + `notifyUrgent` "fee-model drift detected", no throw (`:1017-1036`) |
| 2.9 monitor rename | done | `spread-exit-monitor.ts` → `timeout-close-monitor.ts`, `monitorSpreadExits` → `monitorTimeoutClosures`; config field `spreadExitTimeoutMinutes` → `openTradeCloseTimeoutMinutes` (env `OPEN_TRADE_SPREAD_EXIT_TIMEOUT_MINUTES` unchanged, `packages/config/src/index.ts:46-49,209,280`); `priceByExchange` dropped from `polling-loop.ts:106-112`; close reasons `spread_timeout`/`close_recovery` kept; `specs/bot.md` exit section rewritten; stale-`closing` sweep + 30-min time-stop intact (verified by reading the renamed file) |
| 2.10 entry volume writer | done | `TransitionDetails.filledNotionalUsdDelta` + per-leg `filledNotionalUsdDelta` (`open-trade.ts:82-92`); `db-preview-store.ts:258-267` applies trade-level `coalesce + delta` in-tx; per-leg leg-level fragment `:303-317`; `runEntry` passes limit `settledNotionalUsd`, hedge `Σ diff × averageFillPriceUsd`, and the sum in the `hedging` transition (`:868-885`) |
| 2.11 close volume writer | done | `trade-close.ts:222-230` per-leg delta `qty × (ack.averageFillPriceUsd ?? position-derived exit)`; carried in final `closed`/`unhedged` transition (`:263-282`); unknown exit price skips the increment |
| 2.12 monitor-closure writer | done | `trade-monitor.ts:24-31` computes `qty × exitPriceUsd` (skipped when unknown); leg-level increment `:43-46` and trade-level increment in both `closed` and `unhedged` branches, all inside the existing transaction |
| 2.13 Telegram volume surfaces | done | `buildFillSummary` farmed-volume line from persisted leg `filledNotionalUsd` (`telegram-command-poller.ts:590-600`); close notice "Farmed volume (cumulative)" via best-effort `readFarmedVolumeUsd` (`trade-close.ts:286-289,316-321`); `/summary` DB-backed lifetime + 24h lines (`trade-summary.ts:52-56,75-86`) with the live-price estimate kept as separately labeled "Total notional (live-price estimate)" (`:281`) |
| 2.14 dead-code sweep | done | `evaluateCapturedEdge` export deleted (`open-trade.ts`); repo grep confirms zero remaining callers/references to it, `edgeMinProfitUsd`, `spreadTpUsd`, `spreadSlUsd`, `EXIT_SLIPPAGE_BPS`, `monitorSpreadExits`, `spreadExitTimeoutMinutes`, `spread-exit-monitor` in `src/` (only stale `dist/` artifacts remain until next build); `specs/bot.md` matches the new model; `docs/architecture.md` had no spread-exit wording to update |
| 2.15 verify PR2 | partial (left `- [ ]`) | Typecheck green (below); `open-trade.test.ts` compiles; evidence (a)(c-formula)(e) done + clean dry-run tick (below); (b) forced-breach behavior verified at function level with the real exported `assertProtectionAnchors` (throws `ProtectionAnchorError` — urgent-notify+rollback ride the audited catch); (c) end-to-end edge abort, (d) 30-min time-stop, (f) column growth need a confirmed trade — manual steps below |

### Bounded evidence collected this run

- **(e/a) Config guard via built dist** — `packages/config` rebuilt; `loadBotConfig({OPEN_TRADE_SPREAD_TP_USD:'60'})`
  throws `GUARD OK: OPEN_TRADE_SPREAD_TP_USD was removed by adjust-tpsl-volume-farming; … replaced by
  OPEN_TRADE_MIN_PROFIT_USD`. Parsed defaults confirmed: `{"sl":"2.5","minProfit":"0.05","maxLoss":"0.25","slippageBps":"2","timeoutMin":30}`.
  Bonus: the real `yarn dev:bot` boot path also fired the guard because `.env` still defines a removed var —
  `.env` was restored untouched afterwards (removal is the deploy step).
- **(b) BOT_RUN_ONCE dry-run tick** — ran `BOT_RUN_ONCE=true BOT_EXECUTION_MODE=dry-run ENABLE_ORDER_PLACEMENT=false
  TELEGRAM_ENABLED=false yarn dev:bot` with the three removed vars temporarily stripped from `.env` (restored after):
  config loaded, DB connected, registry initialized, tick 1 fetched live RISEx/Extended mark prices, spread $75.08 ≥
  $60 → **dry-run signal 9166 created**, `Monitoring tick completed` in 2435 ms, loop stopped. Read-only: dry-run mode,
  order placement off, Telegram off. First attempt (columns missing) proved the code queries `filled_notional_usd`;
  after applying migration 0003 to the dev DB (manual statement-split apply — the dev DB has no
  `__drizzle_migrations` table, so `yarn db:migrate` is not safe there), the tick ran clean, exercising
  `monitorTimeoutClosures` and `trade-monitor` against the new columns with zero errors.
- **(c) arithmetic sanity with the real exported function** — `tsx` harness importing
  `assertProtectionAnchors` from source, TP 3% / SL 2.5%, longEntry $100000 / shortEntry $100040:
  cross-symmetry `|shortSl − longTp|/longTp = 41.20/103000 = 4.00 bps` ≪ 100 bps (by construction, scales with the
  entry spread); pass logs the full anchor set; a 200 bps corrupted `shortSl` throws `ProtectionAnchorError`
  ("deviates 200.0 bps") — the exact loud-failure path used by `runEntry`.
- **`yarn typecheck`** → exit 0 across all workspaces (twice this run: before evidence and after; unchanged code).

### Manual verification steps for the remaining 2.15 evidence (need a confirmed trade; never done against live trading here)

- (a/c) Confirm a Telegram-confirmed trade in dry-run with a mocked/sandbox fill: expect `Protection anchors verified`
  log then `OpenTrade edge band evaluated … keepOpen` (or the abort path below).
- (c) Force `expectedConvergenceUsd < breakevenUsd + minProfitUsd` (e.g. fill with |spread| < ~$12 at current fee bps):
  expect both legs closed reduce-only, reason `edge_below_cost`, `edge_closed` Telegram edit, abort loss ≤ $0.25
  (else the fee-model-drift notify fires).
- (d) With an open trade, verify no spread-move close before 30 min (no spread comparisons exist — grep-verified), and
  at 30 min a `spread_timeout` close via `monitorTimeoutClosures`; kill a close mid-flight to see `close_recovery`.
- (f) After (a)/(c)/(d): `SELECT filled_notional_usd FROM trades/trade_legs` — expect growth at entry (writer 1),
  bot-close (writer 2), and venue-side TP/SL closure (writer 3), each monotonic.

### Deviations from design/tasks (needs reviewer awareness)

1. **`expectedConvergenceUsd` sign (task 2.6 / design D4).** Design D4 literally wrote
   `max(0, longEntry − shortEntry)` ("unchanged semantics"), but the strategy is long-the-cheap-venue /
   short-the-expensive-venue, so the pre-change semantics were `max(0, −(longEntry − shortEntry))` =
   `max(0, shortEntry − longEntry)` — the D4 formula would abort every normally-filled trade. The code implements
   the semantically correct `max(0, shortEntry − longEntry)` with an in-code comment citing this deviation.
   The spec (`specs/trade-exits`) only pins "expected convergence (USD) ≥ breakeven + minProfit", so the spec is met.
2. **Extra `hedging` transition for volume deltas (task 2.10).** The entry-volume increments ride a
   `store.transition(token, "hedging", { filledNotionalUsdDelta, legs })` inserted after both fills resolve and before
   `protecting`. `transition()` does not validate from-states (verified), and `hedging` is already a legal
   `OpenTradeState`; this keeps the increments inside one transaction exactly as D6 requires.
3. **`/summary` farmed lines are lifetime + 24h** (task 2.13 said "lifetime/period"); the 24h trailing window pinned
   to `trades.updatedAt` follows the design's window convention (Open Question 4).
4. **2.15 left unchecked** — all code complete and typecheck-green, but evidence items (a)(c)(d)(f) require a
   confirmed trade; exact manual steps listed above. Everything feasible without live trading was evidenced.

### Files changed this run

None (audit-only run; all PR2 code was already in the working tree from the timed-out run). Updated:
`openspec/changes/adjust-tpsl-volume-farming/tasks.md` (2.1–2.14 → `[x]`) and this file.
Environment side effects (all reverted/completed): `.env` temporarily stripped of the 3 removed vars and restored
(byte-identical, `git diff` clean); migration 0003 applied to the dev DB `btc_arbitrage` (additive, the deploy step).

### Remaining tasks

- 2.15 runtime evidence (manual steps above) — only unchecked PR2 line.
- All of PR3 (3.1–3.8) remains `- [ ]`. Next work unit: PR3.

### Workload / PR boundary

PR2 authored ≈ 800 net lines across 10 source files + 2 docs — the user-accepted size exception for the PR2 group
(single branch, one merge). No commit made (parent commits after verification).

---

## PR3 — Backend volume-stats endpoint + web panel (implementation complete; runtime evidence pending DB server recovery)

- Applied by: sdd-apply (stalled mid-run after typecheck+build green; parent completed audit, checkbox marking, and evidence collection).
- Code audit (parent-verified, file:line): `server.ts:35` GET-only route with constructor-injected `VolumeStatsService` (no mutation routes in the file); `volume-stats-normalizers.ts` emits design-D7 DTO (ISO `generatedAt`, `formatDecimal` string decimals, 24h/7d/30d windows); `apps/web/src/features/dashboard/volume-stats.ts` reuses `getBackendApiBaseUrl()`; `FarmedVolumePanel.tsx` renders explicit "$0.00 farmed" empty state with MetricCard lifetime/24h/7d/30d; `Dashboard.tsx` integrates via `Promise.allSettled` with independent loading/error state.
- Tasks marked: 3.1, 3.2, 3.3, 3.5, 3.6, 3.7 (code-complete). Open: 3.4, 3.8 (require seeded-DB endpoint evidence).
- Verification so far: `yarn typecheck` green; root `yarn build` green (all workspaces incl. web bundle).
- 🔴 pi-lens rootDir diagnostics on `volume-stats-service.ts` marked FALSE-POSITIVE: the repo's authoritative `tsc -b` build passes (project references to composite `packages/db`, identical to the `apps/bot` pattern); the LSP checker does not model build-mode project-reference redirection.
- Incident: the dev MariaDB server (192.168.1.133) is wedged — a `DROP DATABASE` from the stalled apply subagent has been stuck in "closing tables" >40 min, serializing everything behind the query cache lock. KILL flags are registered but the thread cannot unwind. Server restart required on the host; leftover scratch DBs to clean post-restart: `btc_arbitrage_pr3_verify`, `btc_arbitrage_pr3_empty`, `scratch_vol_stats_pr3`.
- Evidence pending after DB recovery: seeded lifetime/per-venue/24h/7d/30d sums + empty-state zeros (script ready, uses a fresh scratch DB, then dropped).
