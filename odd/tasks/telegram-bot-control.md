# Feature: Telegram bot control (pause / restart)

Date: 2026-10-09
Branch: `feat/telegram-bot-control`

## Goal

Telegram command `/bot` showing two inline buttons: ⏸ Pausar and 🔄 Restart.
Both actions are allowed **only when no position is open** (no trade row in
`activeTradeStatuses`) and no execution-queue job is in flight.

- **Pause**: stops price polling, signal evaluation and auto-confirm, but the
  process stays alive: Telegram commands, data retention and the defensive
  trade monitor keep running. Paused state shows ▶️ Reanudar instead of ⏸
  Pausar. Pause does not survive restart (restart implies resume).
- **Restart**: persists the in-memory runtime overrides (cooldown, min spread,
  margin, auto-confirm) to the DB, sends a "reiniciando" notice, then exits the
  process with code 0. Docker `restart: unless-stopped` boots the container
  again (which also re-runs git pull + yarn install). At boot, persisted
  overrides are re-applied on top of env config so hot-changed settings
  survive the restart.

## Design contract (agreed before implementation)

- Guard (both pause and restart): `trades.status IN activeTradeStatuses`
  (same set used for signal suppression, covers in-flight executions since the
  trade row exists from confirm start) AND `!executionQueue.isExecuting()`.
- Restart shutdown path: cooperative — `BotControl.requestRestart()` sets a
  flag and wakes the loop's sleep; the polling loop exits its `while`, the
  monitor interval is cleared, `main()` returns, process exits 0. No
  `process.exit()` mid-flight.
- New table `bot_runtime_overrides` (`setting_key` PK varchar(32),
  `setting_value` varchar(64), `updated_at` timestamp). Values stored as
  strings; applied through the existing `apply*` appliers in
  `runtime-settings.ts` so validation/notional recompute stay consistent.
- Env baseline for the `/config` "*" override markers: main.ts snapshots
  `snapshotRuntimeSettings(config)` BEFORE applying persisted overrides and
  passes it to the poller (new optional constructor arg), so restored values
  still show as "ajustado en caliente".
- On boot, if overrides were restored, log loudly and send a Telegram notice
  (when enabled) listing what was restored.
- No new unit tests (paused by user instruction 2026-08-16). Verification =
  `yarn typecheck`.

## Tasks

1. [x] `db-overrides-table` — Drizzle schema `botRuntimeOverrides` +
   migration 0004 (hand-written: 0002/0003 already existed and
   drizzle generate re-emitted existing statements from the meta drift).
2. [x] `runtime-control` — `apps/bot/src/runtime/runtime-control.ts`:
   `BotControl` (pause/resume/requestRestart/isPaused/isRestartRequested,
   wakeable sleep) + `loadActiveTrades(db)` guard helper.
3. [x] `persist-restore-overrides` —
   `apps/bot/src/runtime/runtime-settings-store.ts`: upsert override on change,
   `applyPersistedRuntimeOverrides(db, config)` for boot.
4. [ ] `telegram-bot-command` — `/bot` in AVAILABLE_COMMANDS, state-aware
   message (⏸ Pausar / ▶️ Reanudar + 🔄 Restart), `bot:` callbacks with the
   guard, restart persists overrides + confirm edit + requestRestart;
   optional baseline constructor arg; persist-after-apply in the 4 existing
   setting applier call sites.
5. [ ] `polling-loop-pause` — skip price fetch/signal/auto-confirm while
   paused; loop condition adds `!control.isRestartRequested()`; sleep becomes
   wakeable; monitor interval respects both flags.
6. [ ] `main-wiring` — main.ts: env baseline snapshot → apply persisted
   overrides (log + Telegram notice) → construct BotControl → wire into
   poller + loop.
7. [ ] `typecheck-docs` — `yarn typecheck` green; update `specs/bot.md`
   (commands section) and `AGENTS.md` (Telegram commands + runtime-settings
   persistence note).

## Evidence log

- a044e84 — feat(db,bot): add bot_runtime_overrides table and bot control foundations (tasks 1-3)
