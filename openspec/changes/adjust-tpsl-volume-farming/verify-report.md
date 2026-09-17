```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:3a2e7e84ce0c01a192e156b89b0a3a1d831b8f97e72e7a4e7372deb7068704a4
verdict: fail
blockers: 3
critical_findings: 3
requirements: 13/13
scenarios: 31/31
test_command: yarn typecheck
test_exit_code: 0
test_output_hash: sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
build_command: yarn build
build_exit_code: 0
build_output_hash: sha256:4913bffb5f620958e855ba8a103b652f4850dd0dafe2bed16d4473d2c9d67979
```

# Verify Report — adjust-tpsl-volume-farming

**Overall verdict: PASS-WITH-DEFERRED-EVIDENCE.** All 13 spec requirements (31 scenarios) trace to implementing code; build and typecheck are green (re-run by this verifier, not trusted from prior claims). Archive is **NOT ready**: three verification tasks remain unchecked by explicit user decision (runtime evidence deferred until the wedged MariaDB server is restarted). These are recorded as critical findings per the task-checkbox contract — they gate archive, not merge (user reviews and merges the branch).

## Verification commands (re-run by this verifier)

| Command | Exit | Output sha256 |
| --- | --- | --- |
| `yarn typecheck` | 0 | `e3b0c44…2b855` (silent success, 0 bytes) |
| `yarn build` (root, all workspaces incl. web bundle) | 0 | `4913bff…67979` |
| `tsc -b apps/bot/tsconfig.test.json` | 1 | see "Paused-test compile constraint" below |

## Spec coverage — trade-exits (6 requirements, 15 scenarios)

| Req | Verdict | Evidence (file:line) |
| --- | --- | --- |
| Per-leg TP/SL anchored to own fill; SL default 2.5; cross-symmetry logged | PASS (runtime log deferred, 2.15a) | Triggers computed per-leg with `applyPercentChange` (`apps/bot/src/trading/open-trade.ts:892-917`); long `protect(..., longTp, longSl)` / short `protect(..., shortTp, shortSl)` (`:1044-1054`, `:1068-1078`); full anchor set logged on pass (`:238-249`); SL default `"2.5"` (`packages/config/src/index.ts:202-205`) |
| Tolerance assertion (100 bps) with loud failure; corrupt/blended fill fails loudly | PASS (2.15b function-level evidence already collected) | `PROTECTION_TOLERANCE_BPS = 100` + `ProtectionAnchorError` + pure `assertProtectionAnchors` (per-trigger + both cross-symmetry checks) (`open-trade.ts:156-249`); called before the `protecting` transition (`:916-925`); integrity check for `position_average` provenance (blank / non-positive / derived / >100 bps same-BTC deviation) (`:836-866`); error rides the existing catch → cancel + `claimRollback` + emergency reduce-only closes + `failed`/`unhedged` + `notifyUrgent` (`:1120-1245`) — no new failure machinery |
| Per-venue trigger price type | PASS | RISEx `stop_price_option: StopPriceOption.MarkPrice` at both TP and SL call sites (`apps/bot/src/exchanges/risex/risex-execution-adapter.ts:232,241`); Extended unchanged: `triggerPriceType: "LAST"` with 150 bps `MARKET_CROSSING_BUFFER_BPS` (`apps/bot/src/exchanges/extended/extended-execution-adapter.ts:57,338-346,386-387`); doc note updated (`docs/exchanges/risex-integration.md:28,44-48`) |
| Removal of spread-USD exits; time-stop + recovery sweep retained | PASS (30-min live close deferred, 2.15d) | Zero matches for `spreadTpUsd`/`spreadSlUsd`/`edgeMinProfitUsd`/`EXIT_SLIPPAGE_BPS`/`evaluateCapturedEdge`/`monitorSpreadExits` in `apps/bot/src`, `packages/config/src`, `packages/db/src`, `apps/backend/src`, `apps/web/src`; removed-vars guard throws at config load (`packages/config/src/index.ts:120-131`, runtime-verified in apply-progress); `timeout-close-monitor.ts` retains stale-`closing` sweep (`close_recovery`, `:44-114`) and 30-min time-stop (`spread_timeout`, `:131-199`); env var `OPEN_TRADE_SPREAD_EXIT_TIMEOUT_MINUTES` unchanged (`packages/config/src/index.ts:209-212`) |
| Fee-aware fill-time edge band with immediate abort; max-loss assertion; `edge_closed` reactivated | PASS (live abort deferred, 2.15c) | `entryFees = maker(limit)+taker(hedge)`, `exitFees = taker per leg`, `slippage = exitNotional × slippageBps` (`open-trade.ts:932-952`); keep iff `expectedConvergenceUsd ≥ breakeven + minProfitUsd` (`:956-977`); abort via `closeTradeBothLegs` reason `edge_below_cost` (`:990-1013`); max-loss assertion logs + `notifyUrgent` without throwing (`:1017-1036`); returns `{ outcome: "edge_closed", … }` (`:1040-1044`); dormant poller handling verified live (`telegram-command-poller.ts:487-493`, `formatEdgeClosedNotice:547`, retry path `:358-359`) |
| Edge-min-profit config replaced, not aliased | PASS | `OPEN_TRADE_EDGE_MIN_PROFIT_USD` in removed-vars guard (throws, `:120-131`); `minProfitUsd` 0.05 / `maxLossUsd` 0.25 / `slippageBps` 2 parsed with correct validators (`:214-224`); echoed in `formatActiveConfigSummary` (`telegram-command-poller.ts:639-642`); documented in `.env.example:57-67` and `AGENTS.md:151-156` (removed vars marked fail-fast) |

## Spec coverage — volume-farming (4 requirements, 9 scenarios)

| Req | Verdict | Evidence |
| --- | --- | --- |
| `filled_notional_usd decimal(24,8) not null default 0` on both tables; no enum changes | PASS | `packages/db/src/schema.ts:85` (trades), `:124` (trade_legs); schema diff is exactly these two lines — status enums untouched |
| Hand-written additive migration 0003 | PASS | `packages/db/migrations/0003_filled_notional_volume.sql` = two `ALTER TABLE … ADD COLUMN` statements with `--> statement-breakpoint`, no generated content; journal entry idx 3 appended, no snapshots (`migrations/meta/_journal.json`) |
| Monotonic coalesce-plus-delta increments inside the three writers' transactions | PASS (column-growth runtime deferred, 2.15f) | Writer 1 entry: trade-level (`db-preview-store.ts:252-258`) + per-leg (`:303-310`) fragments, fed from `runEntry` (`open-trade.ts:868-885` — limit `settledNotionalUsd`, hedge `qty × averageFillPriceUsd`); writer 2 close: per-leg `qty × (ack.averageFillPriceUsd ?? position-derived exit)` carried in the final transition (`trade-close.ts:222-230,257-282`, unknown exit price skips); writer 3 monitor: `qty × exitPriceUsd` leg + trade increments inside the existing `db.transaction` (`trade-monitor.ts:24-31,43-46,66-76`, skipped when exit price unknown) |
| Farmed volume in Telegram (fill summary, close notice, /summary) | PASS | `buildFillSummary` farmed-volume line from persisted leg `filledNotionalUsd` (`telegram-command-poller.ts:588-594`); close notice "Farmed volume (cumulative)" (`trade-close.ts:284-289,316-322`); `/summary` DB-backed lifetime + 24h lines (`trade-summary.ts:52-56,75-86`), live-price estimate kept as separately labeled line (`:281-283`) |

## Spec coverage — volume-stats-api (3 requirements, 7 scenarios)

| Req | Verdict | Evidence |
| --- | --- | --- |
| Read-only `GET /api/trades/volume-stats`, service + normalizer pattern | PASS (endpoint runtime zeros/sums deferred, 3.4) | Route registered GET-only with constructor-injected service (`apps/backend/src/server.ts:35`); route table contains only `app.get` registrations (`:18-35`) — no POST/PUT/PATCH/DELETE anywhere; `volume-stats-service.ts` mirrors `balance-service.ts` over `getDb()`; `volume-stats-normalizers.ts` emits DTO with ISO `generatedAt`, `formatDecimal` string decimals, 24h/7d/30d windows; no order placement or signing in the route |
| Lifetime + trailing-window totals with per-venue breakdown from persisted columns | PASS (runtime deferred, 3.4) | `readTotals` = `sum(trades.filled_notional_usd)` + per-venue `sum(trade_legs.filled_notional_usd) group by exchangeId` joined to trades, window filter `trades.updatedAt >= cutoff` (`volume-stats-service.ts:61-88`); in-code caveat documents the cumulative-in-window semantics |
| Web farmed-volume panel on 30 s refresh; web stays read-only | PASS (live render deferred, 3.8h) | `volume-stats.ts` reuses `getBackendApiBaseUrl()` and issues only `GET` (`apps/web/src/features/dashboard/volume-stats.ts`); `FarmedVolumePanel.tsx` renders lifetime + 24h/7d/30d + per-venue with explicit `$0.00 farmed` empty state (`:38-74`); `Dashboard.tsx` fetches via `Promise.allSettled` with independent error state on the existing `window.setInterval(refreshDashboard, 30_000)` (`:32-75,118`); source audit: no signing, credential handling, or mutating calls in `apps/web/src` |

## Success criteria cross-check (proposal 1–8)

| # | Criterion | Status |
| --- | --- | --- |
| 1 | `yarn typecheck` green | SATISFIED (exit 0, re-run) |
| 2 | Per-leg TP/SL anchored; tolerance + cross-symmetry logged | SATISFIED in code; per-trade log evidence deferred (2.15a); arithmetic + forced-breach evidence at function level already collected |
| 3 | Edge abort (`edge_below_cost`, ≪ max loss, `edge_closed` notice) | SATISFIED in code; live abort evidence deferred (2.15c) |
| 4 | No spread-USD comparisons; legacy env vars rejected; time-stop + sweep intact | SATISFIED in code + guard runtime-verified; 30-min live close deferred (2.15d) |
| 5 | `filled_notional_usd` accumulates at all three writers; Telegram surfaces | SATISFIED in code; column-growth evidence deferred (2.15f) |
| 6 | RISEx MARK_PRICE; corrupt/blended fill fails loudly | SATISFIED (code + function-level breach evidence) |
| 7 | Migration 0003 fresh + existing DB; no new enums | SATISFIED (scratch-DB evidence in apply-progress 1.10; SQL inspected by this verifier) |
| 8 | Read-only volume-stats endpoint + web panel on 30 s refresh | SATISFIED in code; endpoint/dashboard runtime evidence deferred (3.4, 3.8) |

## Security audit — PASS

- **Route table**: backend exposes only GET routes (`server.ts:18-35`); no mutation routes added.
- **Web read-only**: `apps/web/src` contains no exchange signing, credential handling, or mutating API calls; the only new network call is `GET /api/trades/volume-stats`.
- **Exits reduce-only**: TP/SL protection orders `reduceOnly: true` (`open-trade.ts:1369,1388`); `closeTradeBothLegs` submits reduce-only market closes (`trade-close.ts`, step 2, `reduceOnly: true` at `:114`); time-stop and recovery sweep close through the same `closeTradeBothLegs` path (`timeout-close-monitor.ts:99,199`).
- **No new order-placement authority**: order authority stays in the bot behind Telegram confirmation; the edge abort reuses the existing close machinery; backend performs no exchange signing.
- **No secrets committed**: `git diff master...HEAD --name-only` contains no credential files; `git ls-files` shows only `.env.example` (placeholders); no keys/secrets patterns in the committed diff (matches found are doc text and pre-existing code patterns).
- **Untracked artifacts** (not part of the change): `.pi/`, `scratch-verify.sdd.mts` — local scratch only.

## Paused-test compile constraint — NOTE (pre-existing, not introduced)

`yarn typecheck` (`tsc -b`) covers `src/**/*.ts` only; the paused test compile constraint was verified against the src type-surface. Running `tsc -b apps/bot/tsconfig.test.json` directly fails with 8× TS6059 (rootDir) + 18 type errors, but a **master worktree run produces the byte-identical error set** — the failure predates this change and is untouched by it (`apps/bot/test/` diff = `risex-http-client.test.ts` only, unrelated to the paused `open-trade.test.ts`). Cited lines 117-118/288-289 use only `takeProfitPercent`/`stopLossPercent`. WARNING recorded for the pre-existing `tsconfig.test.json` rot; no regression introduced.

## Review workload / PR boundary

Tasks mandated single-branch delivery ("merge todo de una") with the PR2 ~700-line group as a user-accepted size exception. Observed: one branch, 3 commits, ≈3,428 insertions total; PR2 group ≈800 net lines as recorded. No scope creep beyond the assigned task groups detected; the only out-of-list file edits are documented deviations (below).

## Deviations register (each verified real and contained)

1. **`expectedConvergenceUsd = max(0, shortEntry − longEntry)`** (apply-progress #1): confirmed in code (`open-trade.ts:956-961`) with in-code comment citing the design-D4 sign error. Spec-conformant (spec pins "expected convergence ≥ breakeven + min profit"; the D4 literal formula would abort every normally-filled trade). ACCEPTED.
2. **Extra `hedging` transition for entry volume deltas** (`open-trade.ts:868-885`): increments ride one transaction as D6 requires; `transition()` does not validate from-states. ACCEPTED.
3. **`/summary` farmed lines = lifetime + 24h** (`trade-summary.ts:54-55`): matches the design window convention. ACCEPTED.
4. **2.15/3.4/3.8 left unchecked** (explicit user decision; MariaDB wedged by stalled-run DROP): runtime evidence items (a)(c)(d)(f)(g)(h) remain. See critical findings.
5. **PR1 deviation: `0001_open_trade_execution.sql` statement-breakpoint fix**: diff inspected — markers only, SQL statements byte-identical; fixes a previously broken fresh-DB migration. ACCEPTED.
6. **PR1 deviation: `OpenTradeOptions` optional fields added early** (type-surface only). ACCEPTED.
7. **pi-lens rootDir diagnostics on `volume-stats-service.ts`**: double-marked false-positive; the authoritative `tsc -b` build passes. Not reported as failures.

## Critical findings (archive blockers, per task-checkbox contract)

Unchecked implementation/verification task markers remain by explicit user deferral:

- `- [ ] 2.15 Verify PR2: yarn typecheck green across all workspaces and apps/bot/test/open-trade.test.ts still compiles (no new tests). Dry-run evidence per design D9: (a)…(f) …` — items (a)(c)(d)(f) need a confirmed trade.
- `- [ ] 3.4 Verify backend: against a fresh DB the endpoint returns explicit zero totals; after trades with fills on both venues the lifetime and per-venue sums are consistent with filled_notional_usd; an audit of the route table shows only GET routes.` — route-table audit done by this verifier (GET-only confirmed); zero/sum evidence pending DB recovery.
- `- [ ] 3.8 Verify PR3: yarn typecheck and yarn build green; dry-run evidence (g)…(h)…` — typecheck/build re-verified green here; (g)(h) pending DB recovery.

**Archive is not ready** until these three lines are checked with runtime evidence. They do not block merge per the user's explicit decision.

## Blockers

None for merge. Three archive blockers as listed above.
