# Feature: /config time-stop presets (metals + ETFs)

Runtime-adjustable `GOLDSILVER_TIME_STOP_HOURS` / `SPYQQQ_TIME_STOP_HOURS`
from the Telegram `/config` submenus, with preset buttons (2/3/4 days) plus
custom hours. Approved by the operator 2026-11 (flow mock confirmed before
implementation).

Behavior contract (confirmed by operator):

- New button `⏳ Time-stop 🥇` next to `🎯 TP floor 🥇` in the Metals
  submenu; `⏳ Time-stop 📈` next to `🎯 TP floor 📈` in the ETFs submenu.
- Tap → preset menu (inline keyboard, mirrors the existing `cd:` cooldown
  pattern):
  - `2 days (48h)` → `ts:metal:48` / `ts:etf:48`
  - `3 days (72h)` → `ts:metal:72` / `ts:etf:72`
  - `4 days (96h)` → `ts:metal:96` / `ts:etf:96`
  - `✏️ Custom (hours)` → pending text prompt, value in hours
  - Menu text shows the current value, e.g.
    `Time-stop 🥇 — close at market when age ≥ threshold (current: 48h)`.
- Presets apply immediately (validate → mutate → persist → ✅ confirmation
  landing back on the strategy submenu), exactly like the `cd:` flow.
- Validation: integer hours, 1–720 (30 days). Out of range → `❌ … Try
  again` (custom prompt stays open).
- Hot-path: the metal/ETF exit monitor reads `strategyConfig.timeStopHours`
  per tick, so the override affects the currently active trade too (same
  semantics as the TP floor).
- Persistence: new `bot_runtime_overrides` keys `metalTimeStopHours` /
  `etfTimeStopHours`, applied at boot by `applyPersistedRuntimeOverrides`.
- `/config` summary: the existing `Time-stop: 48h` segment gets a `*`
  marker when overridden (add `metalTimeStopHours` / `etfTimeStopHours`
  to the baseline + the "adjusted at runtime" OR list).
- Strategy gate: `ts:metal*` / `ts:etf*` callbacks are metal-only (a
  btc-strategy instance answers with the not-available note), alongside
  `set:metal*` / `set:etf*`.

## Tasks

- [x] 1. `apps/bot/src/runtime/runtime-settings.ts`: add
  `metalTimeStopHours` / `etfTimeStopHours` to `RuntimeSettingKey`,
  `RuntimeSettingsBaseline`, `snapshotRuntimeSettings`,
  `isRuntimeSettingOverridden`; shared `applyPairTimeStopHours` +
  exported `applyMetalTimeStopHours` / `applyEtfTimeStopHours`
  mutating `config[section].timeStopHours` (integer, 1–720).
- [x] 2. `apps/bot/src/runtime/runtime-settings-store.ts`: wire the two
  new keys through `readSettingValue`, `parseStoredValue` (number group),
  `knownKeys`, and the boot-time apply switch.
- [x] 3. `apps/bot/src/notifications/telegram-command-poller.ts`:
  submenu buttons, `set:metaltimestop` / `set:etftimestop` preset menus,
  `ts:metal:*` / `ts:etf:*` callback handling (preset apply + custom
  prompt), `pendingSettingPrompt` kinds `metalTimeStop` / `etfTimeStop`,
  apply cases in `handleSettingValueInput`, strategy gate entries,
  summary `*` markers.
- [x] 4. `AGENTS.md`: add the time-stop buttons to the `/config` runtime
  settings list.
- [x] 5. Tests in `apps/bot/test/runtime-settings.test.ts` (node:test +
  tsx, project pattern): new appliers (valid presets, integer/reject
  non-integer, 1–720 bounds), `isRuntimeSettingOverridden` for both
  keys, `formatActiveConfigSummary` time-stop `*` marker (pure,
  exported). User explicitly re-enabled tests for this change.
- [x] 6. `yarn typecheck` green; work-unit commit `7e0b3e6` on
  `feat/config-time-stop-presets` (6 files, 9 tests passing).

## Notes

- Unit tests for this feature ARE in scope — the user explicitly asked
  for them on 2026-11 (overrides the 2026-08-16 pause for this change).
- Work-unit commit at the end; push/PR remain operator decisions.
- Existing precedent to mirror: the cooldown `cd:` preset flow in
  `telegram-command-poller.ts` (~lines 764–850) and the pair appliers in
  `runtime-settings.ts`.
