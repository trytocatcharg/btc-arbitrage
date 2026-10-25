# Feature: Gold/Silver Ratio Monitor (Arcus)

## Goal
Monitor-only v1 of the gold/silver pairs strategy: compute RSI(14) of the GLD-USD/SLV-USD
ratio from Arcus public market data, emit Telegram alerts on RSI-50 crosses, persist
ratio snapshots. No execution in v1 (execution design is agreed but deferred).

## Strategy (operator decision)
- RSI(ratio, 14), source = Arcus `GLD-USD` / `SLV-USD` mark prices (public, no auth).
- RSI > 50 → side `short_gold_long_silver`; RSI < 50 → side `long_gold_short_silver`.
- Alert once per cross (state machine: current side + last cross timestamp). Optional
  confirmation band N (default 0 = strict 50, `GOLDSILVER_RSI_CONFIRM_BAND`).
- Execution (deferred, agreed shape): same entry pattern as BTC bot — passive limit on
  one leg + immediate market hedge on the other; close at net profit target.
- TP default suggestion: `GOLDSILVER_TAKE_PROFIT_NET_USD=1.0` (~5% of $40 total margin
  at 3x leverage; covers ~$0.15 round-trip Arcus fees with ~6x cushion ≈ 0.8% ratio move).

## Design notes
- RSI/z-score are scale-invariant → compute on raw ETF ratio (~7.4); display factor
  (~x9.9, GLD ≈ 0.0934 oz) only when showing "metal-equivalent ratio" in Telegram.
- Warmup at boot: `GET /v1/candles` for both markets (timeframe config, default 1h,
  up to 200 candles) → ratio closes → seed RSI. Then incremental per poll.
- `GOLDSILVER_ENABLED=false` by default.
- No new unit tests (paused by operator instruction 2026-08-16).

## Tasks
1. [x] Explore code & derive edit surfaces
2. [x] Config: goldSilver env vars (GOLDSILVER_ENABLED later removed — pair is the switch)
3. [x] DB: ratio_snapshots table + migration 0006
4. [x] Domain: computeMetalRatio + computeRsi (Wilder) + rsiToSide
5. [x] Arcus market-data client + candle warmup + engine + loop + Telegram
6. [x] Verify: typecheck, build:bot, live smoke (200 warmup closes, RSI 71.31)
7. [x] Pairs-panel integration (operator request): GOLDSILVER pseudo-pair in
   TRADING_PAIRS catalog; loop skips BTC spread pass when active; lazy
   per-tick init with staleness re-warmup; poller guards (pair:apply
   preflight skip, leverage preflight skip, stale-signal open: refuse);
   typecheck + build:bot green.

## Evidence
- Branch: feature/gold-silver-ratio-monitor (uncommitted — delivery is operator's call).
- Foundation worker: completed clean (typecheck exit 0).
- Bot worker: stalled mid-edit twice (subagent runtime issue); parent finished
  inline — fixed unbalanced brace in polling-loop.ts (metal-ratio block had
  been nested inside `if (signal)`; moved to run every tick).
- Live smoke 2026-XX: warmup 200 ratio closes (1h), GLD 371.97 / SLV 49.94,
  ratio 7.4483, RSI(14) 71.31 → side short_gold_long_silver, crossed=true
  (boot-time regime announcement by design).
- /v1/candles shape verified live: { candles, total }, newest-first, µs
  openTime, string OHLCV, isFinal on in-progress bucket; params
  market/timeframe/from/to.

## Execution phase (operator decisions 2026-10-23, locked)
- **Entry**: one-click from the RSI-cross alert (Open Trade button, execution queue),
  mirroring the BTC flow. Passive post-only LIMIT on GLD + immediate MARKET
  hedge on SLV. Sizing reuses `OPEN_TRADE_MARGIN_USD` (per leg) x `LEVERAGE`
  (notional per leg); dollar-neutral legs. Preflight: arcus execution adapter.
- **TP**: RSI(14) of the ratio returns across 50 AND net PnL >= estimated
  exit breakeven (fees) + `GOLDSILVER_TP_MIN_NET_USD` (default $10) ->
  paired dual-limit close (reduce-only, top-of-book + improve ticks).
- **Floor unmet**: `GOLDSILVER_TIME_STOP_HOURS` (48h) after the completed
  hedge -> market close if net >= breakeven; a losing trade keeps running to
  TP floor or SL.
- **SL**: net PnL <= -`GOLDSILVER_STOP_LOSS_MARGIN_PERCENT` (50) of TOTAL
  margin (2 x marginUsd) -> IMMEDIATE market close on both legs.
- **Paired-close mechanics**: when one leg fills, the other is repriced every
  `GOLDSILVER_EXIT_REPRICE_INTERVAL_MS` (2s) toward the new top of book;
  first of (slippage budget `GOLDSILVER_EXIT_SLIPPAGE_BUDGET_BPS` 40bps /
  `GOLDSILVER_EXIT_MAX_WAIT_MS` 60s / `GOLDSILVER_EXIT_MAX_REPRICES` 8) ->
  market the remainder. If even market fails -> trade `unhedged` + urgent
  notify (existing emergency contract).
- **Persistence**: reuse `trades`/`trade_legs` (symbol GOLDSILVER, both legs
  exchange arcus; leg market derived from side: short leg = GLD-USD, long leg
  = SLV-USD for short_gold_long_silver, reversed otherwise). No schema change.
- Fees: real per-fill fees from Arcus `/v1/fills` (adapter already recovers
  them); funding ignored in v1 net (noted as follow-up).

## Tasks (execution phase)
- [x] Spec + config vars (GOLDSILVER_TP_MIN_NET_USD, _STOP_LOSS_MARGIN_PERCENT,
  _EXIT_*, _TIME_STOP_HOURS; GOLDSILVER_TAKE_PROFIT_NET_USD removed as
  superseded). Typecheck green.
- [x] Metal-trade service: entry limit+market state machine
  (metal-trade-service.ts: createMetalTrade / executeMetalTradeEntry /
  closeMetalTrade / finalizeClosedTrade)
- [x] Monitor de PnL + triggers (metal-trade-monitor.ts:
  evaluateMetalTradeExitTriggers — wired per ratio tick in polling-loop)
- [x] Paired dual-limit close + repricing + market fallback
  (40bps/60s/8 budget, atomic open->closing claim, stale-closing recovery
  owns failures)
- [x] Telegram: Open Trade button on the ratio alert (`metaltrade:open:`
  one-click, execution queue) + state notices
- [x] Verify: typecheck + build:bot green (live dry-run smoke pending
  operator deploy with DB + Arcus credentials)

## Deferred (post-execution)
- **Auto-confirm/auto-trade: REJECTED by operator (2026-10-23)** — entry stays
  manual (alert button only). Do not re-propose unless asked.
- TP/SL protective resting orders per leg (operator: "mas adelante").
- Funding-fee accrual in net PnL.
- /lastsignal-style ratio history command.
- RISEx XAU/XAG metal-native ratio source.
- Arcus candle WebSocket.
