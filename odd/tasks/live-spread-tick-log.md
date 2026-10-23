# Feature: live-spread-tick-log

Show the last 10 spread ticks in `/lastsignal` regardless of threshold, by persisting
every tick into the existing `spread_snapshots` table (which today is never written).

## Context

- `SignalEngine.evaluate()` returns null below `MIN_PRICE_DIFF_USD`; only threshold-passing
  ticks are inserted into `signals`, so `/lastsignal` can only ever show those.
- `spread_snapshots` (schema ready, incl. `threshold_matched` + two indexes) and
  `price_snapshots` exist in the schema but have **no writers anywhere in the repo**
  (verified by repo-wide grep). Retention already prunes both tables daily and guards
  `spread_snapshots` rows referenced by `signals.spread_id`.
- Operator decision (this session): modify `/lastsignal` itself (not a new command) and
  persist **only `spread_snapshots`** (one INSERT per tick, not two).

## Tasks

1. **Persist every spread tick into spread_snapshots** — in
   `apps/bot/src/runtime/polling-loop.ts` `runSignalPass`: insert the spread right after
   `calculateSpread`, capture the insert id, and set `signalRow.spreadId` so signals link
   to their spread row. The insert must be failure-isolated (try/catch + log) so a logging
   failure never blocks signal emission.
2. **Rewrite /lastsignal to read spread_snapshots** —
   `apps/bot/src/notifications/last-signals-summary.ts`: last 10 rows
   (`order by calculated_at desc`), left join `signals` on `spread_id` to show
   `→ signal #N` when the tick generated a signal; marker for `threshold_matched`.
   Keep the local-timezone + relative-age formatting.
3. **Typecheck and docs** — `yarn typecheck`; fix the stale "Persists price snapshots,
   spread snapshots" line in `AGENTS.md` (only spread snapshots get persisted).

## Non-goals

- No `price_snapshots` writes (no consumer; keeps the per-tick cost at one INSERT).
- No unit tests (paused by explicit user instruction 2026-08-16).
- No retention changes — the existing daily prune already covers the new writes.
- No new Telegram command.

## Evidence

- `yarn typecheck` — clean (2026, this session).
- Commit: pending — operator has not requested a commit; delivery remains the operator's decision.
- Behavior notes: the spread insert is failure-isolated (try/catch → null) so a DB
  hiccup can never drop a signal; `/lastsignal` now reads `spread_snapshots`
  (`order by calculated_at desc limit 10`), left-joined to `signals` for the
  `→ signal #N` reference.
