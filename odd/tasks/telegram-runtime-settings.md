# Feature: Telegram /config runtime settings

Operator-adjustable bot settings from the Telegram `/config` command, applied
in-memory to the shared `BotConfig` object (no restart, no persistence —
restart reverts to env values; decision: in-memory only, 2026-10-06).

Settings exposed:

1. Telegram alert cooldown (minutes → ms)
2. Min spread (`minPriceDiffUsd`)
3. Open trade margin per leg (recomputes `notionalUsd = margin × leverage`)

## Tasks

- [x] 1. Add `apps/bot/src/runtime/runtime-settings.ts`: validated appliers
  (`applyCooldownMinutes`, `applyMinSpreadUsd`, `applyMarginUsd`) mutating the
  live `BotConfig` in place, with a baseline snapshot helper to mark
  overridden values in the `/config` summary. Sanity caps: cooldown 1–10080
  min, spread/margin > 0 and ≤ 10000.
- [x] 2. Make the monitoring loop read the current threshold each tick:
  construct `SignalEngine` per tick in `runtime/polling-loop.ts` (stateless
  class; constructor signature unchanged so existing tests stay green).
- [x] 3. Telegram UX in `notifications/telegram-command-poller.ts`:
  `/config` summary + 3 inline buttons; cooldown submenu (5/30/60/custom
  minutes); pending-prompt state consuming the next operator text message
  for custom/spread/margin values; cancel flow; authorized chat/user only.
- [x] 4. `yarn typecheck` green; report evidence.

## Notes

- All consumers share the same `BotConfig` reference from `main.ts`:
  notifier reads `telegram.alertCooldownMs` per check; `calculateSpread`
  and `buildOpenTradeOptions` read per use → in-place mutation propagates.
- Operator-facing copy in Spanish (project convention for Telegram texts);
  code comments in English.
- No new tests (unit-test work paused by user instruction 2026-08-16).
- No commit without explicit user request.
