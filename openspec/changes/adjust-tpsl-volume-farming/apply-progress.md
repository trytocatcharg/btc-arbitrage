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
