# Bot instance split (BTC + metal as separate processes)

**Status:** PLANNED — design approved by operator 2026-11-12, pending
implementation. Do NOT start without re-confirming the open decision at
the bottom.

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

## Migration 0009 (sketch)

Hand-written, same style as 0007/0008 (drizzle-kit generate not trusted
here — snapshot drift in migrations/meta).

Column on: `trades`, `trade_previews`, `bot_runtime_overrides`
(PK becomes `(setting_key, bot_instance)`), `telegram_command_logs`.
NOT on: `trade_legs`, `unhedged_leg_samples`, `ratio_snapshots`,
`spread_snapshots`, `signals`, `events`, `operations` (derivable by join
or single-strategy).

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

Also: `_journal.json` entry (idx 9), drizzle schema.ts, and a note in
AGENTS.md's migration-drift landmines.

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

## Open decision (ask the operator before implementing)

The backfill `UPDATE`s assume instance ids `btc` / `metal`. Confirm the
final values (they're baked into the migration backfill and every
deploy env).
