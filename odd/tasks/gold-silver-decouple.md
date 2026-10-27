# Feature: gold-silver-decouple

Reformulate the gold/silver ratio strategy from an always-on monitor tied to
the BTC pair selection into an on-demand trade opened from `/ratio`, coexisting
with the active BTC spread strategy.

## Operator decisions (2026-10-26)

- G/S is **removed from the Pairs panel**; the BTC spread strategy pair is the
  only selectable pair.
- `/ratio` is available **anytime** (regardless of the active BTC pair) and
  opens a metal trade on demand. If a G/S trade is already active, `/ratio`
  still renders the chart but **hides the open buttons** and says an active
  trade exists (with the trade id).
- One metal trade at a time (`createMetalTrade` already enforces this; the
  "must be active pair" guard is removed).
- BTC signal suppression **ignores** active G/S trades so both strategies run
  concurrently.
- Env vars shared with BTC are split out (decision: all of them get their own):
  - `GOLDSILVER_MARGIN_USD` (was `OPEN_TRADE_MARGIN_USD`)
  - `GOLDSILVER_LEVERAGE` (was `LEVERAGE`)
  - `GOLDSILVER_LIMIT_TIMEOUT_MS` (was `OPEN_TRADE_LIMIT_TIMEOUT_MS`)
  - `GOLDSILVER_LIMIT_REPRICE_INTERVAL_MS` (was `OPEN_TRADE_LIMIT_REPRICE_INTERVAL_MS`)
  - `GOLDSILVER_ENTRY_IMPROVE_TICKS` (was `OPEN_TRADE_ENTRY_IMPROVE_TICKS`)
  Defaults equal the current shared values.
- Metal ticker/exit pass runs **only while a G/S trade is active** (lazy
  warmup). No RSI alerts, no alert cooldown, no ratio_snapshots in idle.
- Active-trade summary for GOLDSILVER trades hides entry/live spread lines and
  labels legs by asset: `LONG GLD (arcus)` / `SHORT SLV (arcus)` (market read
  from `leg.raw.market`).

## Task 1 note

`loadActiveMetalTrade` now takes `Pick<MetalTradeContext, "db">` so `/ratio`
can call it without execution/config. `BTC_SYMBOL=GOLDSILVER` fails config
load (fail fast) in addition to the persisted-override boot fallback.

1. [x] Config: new `GOLDSILVER_*` vars (margin, leverage, entry loop) with
   defaults equal to current shared values; load into `config.goldSilver`;
   `.env.example`.
2. [x] Remove G/S from `TRADING_PAIRS` (domain); clean dead guards (main.ts
   preflight skip, position-reconciler skip, command-poller branches); boot
   fallback if a persisted runtime override still says GOLDSILVER.
3. [x] polling-loop: metal pass decoupled from `btcSymbol`, runs only while an
   active G/S trade exists (exits: RSI-TP, SL, time-stop); lazy warmup; delete
   alert emission (`notifyMetalRatioSignal`) + cooldown gate; no ratio
   snapshots while idle.
4. [x] `/ratio`: drop active-pair requirement; when an active G/S trade
   exists, send chart with warning caption (trade id) and NO inline buttons.
5. [x] `metaltrade:open:` callback + `createMetalTrade`: drop
   `btcSymbol === GOLD_SILVER_SYMBOL` guard; guard = no active metal trade +
   arcus execution available.
6. [x] BTC signal suppression filters out GOLDSILVER trades.
7. [x] trade-summary: GOLDSILVER trades hide entry/live spread; leg headers
   show asset market (`LONG GLD (arcus)`).
8. [x] Docs: AGENTS.md gold/silver section, specs/docs updates,
   `odd/tasks/gold-silver-decouple.md` (this file).

## Evidence

- Commits: see branch `feature/gold-silver-decouple` (work-unit commits below).
- Typecheck: `yarn typecheck` clean.
- Tests: packages/config + packages/domain green (10/10); bot targeted tests
  green except `trade-summary.test.ts` "summarizes multiple active trades with
  live quotes", which fails identically on `master` (pre-existing, not caused
  by this refactor; unit-test work is paused by operator instruction).

## Follow-up 2026-10-27: symmetric coexistence + Arcus rate-limit caps

Operator decisions: BTC trades never use Arcus (disjoint venues), `/bot`
pause stays MANUAL, and during a pause only the metal exit tick must stay
alive. Changes on top of the commits above (same branch):

- `db-preview-store.ts`: `hasBlockingExecution()` excludes GOLDSILVER
  trades → BTC preview/confirm no longer blocked by an active metal trade
  (second BTC trade with an active BTC trade still refused).
- `trade-monitor.ts`: while a G/S trade is active, Arcus leg position
  polls are throttled to `GOLDSILVER_PRICE_POLL_INTERVAL_MS` (5 s) via a
  per-leg timestamp map (429 cap; detection latency ~5 s is safe because
  metal exits are evaluated from the mark-price tick, not this poll).
- `polling-loop.ts`: `runMetalRatioPass` now also runs while the bot is
  paused (operator /bot pause); it no-ops without an active metal trade,
  so a paused idle bot still makes no Arcus calls.
- `AGENTS.md`: "Coexistence with the BTC strategy" section.
