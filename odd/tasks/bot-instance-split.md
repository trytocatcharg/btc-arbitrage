# Bot instance split (BTC + metal as separate processes)

**Status:** CODE PHASE DONE (uncommitted, verified by gentle-ai-verify +
`yarn typecheck` exit 0) — pending operator deploy. Migration 0010
applied to the live DB manually 2026-11. Do NOT deploy without reading
the transition note at the bottom.

## Goal

Run two bot processes against the SAME database:

- `BOT_INSTANCE=btc` — spread strategy (signal pass, BTC open-trade,
  /arb screener trades, position monitor for BTC legs).
- `BOT_INSTANCE=metal` — gold/silver strategy only (ratio tick, metal
  exits, position monitor for metal legs).

Different Telegram tokens per instance, different exchange wallets per
instance. Ownership is explicit: each row is stamped with the instance
that created it; every ownership decision filters by the column, never
by symbol.

## Why a column (design decision 2026-11-12)

Symbol-derived ownership (`GOLDSILVER` vs rest) was the first option but
the operator chose an explicit `bot_instance` column: it covers symbols
the derivation can't (an /arb trade on any screener symbol), it makes
rows self-descriptive, and it enables per-instance runtime overrides via
a composite PK. The symbol keeps describing WHAT the trade is; the
column decides WHO owns it.

## Landmine this fixes (critical, from the gap analysis)

`trade-monitor.ts` marks a leg `closed` when `getPosition` returns null.
Two instances sharing a DB but using different wallets would each see
the OTHER instance's legs as position-less and falsely close them,
 fabricating closures/PnL. Every monitor/recovery/reconciler query must
be instance-scoped BEFORE any split is deployed.

## Migration 0010 (hand-written, file ready)

Hand-written, same style as 0007/0008 (drizzle-kit generate not trusted
here — snapshot drift in migrations/meta). File:
`packages/db/migrations/0010_bot_instance.sql` (journal entry added,
idx 10). 0009 was already taken by `ratio_snapshots_pair_symbol`, so
the split migration is 0010, not 0009 as originally sketched.

Column on: `trades`, `trade_previews`, `bot_runtime_overrides`
(PK becomes `(setting_key, bot_instance)`), `telegram_command_logs`
(kept `'legacy'` — command history can't be attributed retroactively).
NOT on: `trade_legs`, `unhedged_leg_samples`, `ratio_snapshots`,
`spread_snapshots`, `signals`, `events`, `operations` (derivable by join
or single-strategy). Plus `trade_instance_status_idx`
(`bot_instance`, `status`) for the instance-scoped monitor queries.

Backfill (deviations from the original sketch, both operator-visible):
- `trades`: `symbol IN ('GOLDSILVER','SPYQQQ')` → `'metal'` (SPYQQQ did
  not exist when the sketch was written), rest → `'btc'`.
- `bot_runtime_overrides`: `metal%` AND `etf%` keys → `'metal'` (etf* =
  SPY/QQQ settings), rest → `'btc'`.
- `trade_previews`: from parent trade via join, else `'btc'`.

Applied MANUALLY by the operator (paste, not `yarn db:migrate`)
(operator policy 2026-11: migrations are ALWAYS applied by hand;
`__drizzle_migrations` does not exist in the DB and must not be created
— `yarn db:migrate` would try to re-apply 0000+ and fail).

```sql
ALTER TABLE `trades` ADD COLUMN `bot_instance` varchar(32) NOT NULL DEFAULT 'legacy';
ALTER TABLE `trade_previews` ADD COLUMN `bot_instance` varchar(32) NOT NULL DEFAULT 'legacy';
ALTER TABLE `telegram_command_logs` ADD COLUMN `bot_instance` varchar(32) NOT NULL DEFAULT 'legacy';
ALTER TABLE `bot_runtime_overrides` ADD COLUMN `bot_instance` varchar(32) NOT NULL DEFAULT 'legacy';

UPDATE `trades` SET `bot_instance` = 'metal' WHERE `symbol` = 'GOLDSILVER';
UPDATE `trades` SET `bot_instance` = 'btc'   WHERE `symbol` <> 'GOLDSILVER';
UPDATE `bot_runtime_overrides` SET `bot_instance` = 'metal' WHERE `setting_key` LIKE 'metal%';
UPDATE `bot_runtime_overrides` SET `bot_instance` = 'btc'   WHERE `setting_key` NOT LIKE 'metal%';

ALTER TABLE `bot_runtime_overrides` DROP PRIMARY KEY;
ALTER TABLE `bot_runtime_overrides` ADD PRIMARY KEY (`setting_key`, `bot_instance`);
```

Also: `_journal.json` entry (idx 10, done), drizzle schema.ts, and a
note in AGENTS.md's migration-drift landmines.

## Config

- New env `BOT_INSTANCE` (default `'main'` — a standalone bot keeps
  working unchanged). Parsed in `loadBotConfig()` → `config.instanceId`,
  shown in the `/config` summary and the boot log.
- Separate env `BOT_STRATEGY=btc|metal|both` (default `both`) decides
  WHAT the process runs: which adapters get built (metal instance must
  NOT build risex/extended), which loop passes run, which Telegram
  surface renders. `BOT_INSTANCE` = identity/ownership; `BOT_STRATEGY` =
  behavior. They coincide in the operator's setup but are distinct
  concepts.

## Stamp sites (the only INSERTs that change)

1. BTC open-trade trade row (open-trade.ts / preview consume).
2. `createMetalTrade` (metal-trade-service.ts).
3. `/arb` preview insert (db-preview-store.ts) + signal preview insert.
4. `telegram_command_logs` write helper.

## Query changes (the repeated pattern)

`ne/eq(trades.symbol, GOLD_SILVER_SYMBOL)` as an OWNERSHIP filter
becomes `eq(trades.botInstance, config.instanceId)` in:

- `monitorTrades`, `sampleUnhedgedLegs`, `recoverStaleClosingTrades`
  (kills the landmine).
- `hasActiveTrades`, `hasBlockingExecution`, `loadClosableTrades`,
  `/trade` summary + close buttons.
- Signal suppression + open-trade entry guard.
- Position reconciler scan.
- `applyPersistedRuntimeOverrides` / `persistRuntimeOverride`
  (WHERE + onDuplicateKeyUpdate on the composite PK).
- `loadActiveMetalTrade`.
- Loop split: BTC strategy runs signal pass + BTC monitor; metal
  strategy runs only the metal pass + metal monitor. The paused-branch
  metal-scoped monitor added 2026-11-12 gets absorbed (the metal
  instance always runs its own full monitor).
- Telegram surface per mode: `/config` shows only own buttons; `/arb`,
  `/lastsignal`, `/volume` BTC-only; `/ratio` + metal buttons metal-only.

## Edge cases (decided)

- Two processes with the same BOT_INSTANCE + wallet: undetectable at
  boot; documented, no heartbeat in v1.
- Data retention: run the pruner in ONE instance only.
- Web/backend: read-only over everything; optional instance filter later.

## Transition plan

1. Migration 0009 (backfill included) — safe while the current single
   bot runs (new column defaults `'legacy'`; new filters deploy after).
2. Deploy the single bot with the new code, `BOT_INSTANCE` set to the
   real value (see open decision).
3. Boot the second instance with its own Telegram token + Arcus wallet.

## Implementation tasks (code phase)

1. `schema.ts`: `botInstance` column on trades/tradePreviews/telegramCommandLogs; botRuntimeOverrides column + composite PK. (Done — column added manually by operator.)
2. Config: `BOT_INSTANCE` (default `'main'`) → `config.instanceId`; `BOT_STRATEGY=btc|metal|both` (default `both`) → `config.strategy`. Validate, show in `/config` summary + boot log.
3. Stamp sites: BTC open-trade insert, `createMetalTrade`, preview inserts (db-preview-store), telegram_command_logs (schema-only — no writer exists in code today).
4. Instance-scope ~10 queries (strict `eq(botInstance, instanceId)`, see semantics below).
5. Loop split + adapter construction per strategy + Telegram surface gating.
6. Typecheck clean. (Done — plus F2 hardening: monitorTrades config,
hasActiveTrades/loadClosableTrades/loadActiveTrades instanceId, and
TradeSummaryDependencies.config are all REQUIRED — no unscoped mode.)

## Post-verify notes

- F1 (CONFIRMED by operator 2026-11: keep conservative):
  `runtime-control.ts` `loadActiveTrades` (/bot pause/restart + pair:apply
  guards) stays CROSS-INSTANCE on purpose — an instance cannot restart
  while the OTHER instance has an open trade. Over-blocking, never
  under-blocking. Do NOT instance-scope it without a new operator
  decision.
- One ripple outside the planned surfaces: `open-trade-factory.ts`
  (2 lines) passes `config.instanceId` into both DbPreviewStore
  constructions — unavoidable, that's where the stores are built.
- BTC-entry guards keep `AND notInArray(symbol, ARCUS_PAIR_SYMBOLS)`
  alongside the instance filter: that symbol check is the strategy-KIND
  discriminator (gold-silver-decouple), not ownership. Removing it would
  let an active metal trade block BTC entries on a `both` instance.
- `telegram_command_logs.bot_instance` is schema-only: no writer exists
  in code (verified by grep).

## Ownership semantics (refined during mapping)

- EVERY ownership decision is strict `eq(trades.botInstance, config.instanceId)` — no symbol fallback, no `'legacy'` OR-branch. The backfill left zero `'legacy'` trade rows, and a both-strategy instance only sees rows stamped with its own id.
- Consequence for the transition: the pre-split single bot CANNOT keep running both strategies after this code deploys with its real instance id — deploy = stop bot, set `BOT_INSTANCE`/`BOT_STRATEGY` per instance, start both (step 2+3 of the transition plan happen together). No broken window beyond downtime.
- Runtime overrides: each instance applies only rows WHERE bot_instance = its id (backfilled metal%/etf% → metal, rest → btc).
- Retention pruner runs in the instance whose strategy includes btc (both → runs; metal-only → doesn't).

## Open decision (CONFIRMED 2026-XX: `btc` / `metal`)

The operator green-lit the migration with instance ids `btc` / `metal`
baked into the backfill. If an id ever changes, the backfill in
0010_bot_instance.sql and every deploy env change together.
