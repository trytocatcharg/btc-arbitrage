# Trade Exits Specification

## Purpose

Define the exit and protection model for Telegram-confirmed hedged open trades: per-leg percentage TP/SL orders anchored to each leg's own true fill price, a loud-failure tolerance assertion at the protection step, per-venue trigger price types, removal of spread-USD exits (time-stop and stale-closing recovery sweep retained), and a fee-aware fill-time edge band that aborts net-negative fills immediately.

## ADDED Requirements

### Requirement: Per-leg TP/SL percent orders anchored to each leg's own fill price

The system SHALL place per-leg reduce-only TP and SL orders (`take-profit-market` / `stop-market`) computed as TP = leg fill price × (1 + TP%) and SL = leg fill price × (1 − SL%), with the SL default changed from 3% to 2.5% (`OPEN_TRADE_STOP_LOSS_PERCENT` default `"2.5"`). Each leg's protection orders SHALL be anchored to that leg's own true fill price (the long leg to the long fill price, the short leg to the short fill price), replacing the prior cross-anchor where the short leg inherited the long leg's trigger levels. After computing triggers, the system SHALL verify and log the cross-symmetry property — the short leg's SL level ≈ the long leg's TP level and the short leg's TP level ≈ the long leg's SL level within the protection tolerance — rather than assuming it.

#### Scenario: Dry-run-confirmed trade receives per-leg-anchored protection

- **WHEN** a trade is confirmed and both legs fill (limit leg at `limitFillPrice`, hedge leg at the hedge fill price)
- **THEN** the long leg's TP equals the long fill price × 1.03 and SL equals the long fill price × 0.975, the short leg's TP equals the short fill price × 1.03 and SL equals the short fill price × 0.975, and the cross-symmetry check is logged

#### Scenario: Default stop-loss percent is 2.5

- **WHEN** config is loaded without `OPEN_TRADE_STOP_LOSS_PERCENT` set
- **THEN** the effective SL percent used for protection orders is 2.5

### Requirement: Tolerance assertion at the protection step with loud failure

The system SHALL assert, immediately before submitting protection orders, that (a) each trigger is within 100 bps of the expected `leg fill × (1 ± percent)` level and (b) the two legs' trigger levels satisfy the cross-symmetry check within the same 100 bps tolerance. On any breach the system SHALL NOT place the protection orders; it SHALL treat the condition as an execution failure (urgent notify + rollback / `failed` handling). The system SHALL treat a corrupt or blended fill price — including a blank (`""`) RISEx `avg_entry_price` or a signed-size-derived position-average fallback from `readPositionEntryPrice` — as a loud failure of the protection step, never as a silently mis-anchored order. The true fill price from the order ack SHALL be preferred wherever available; the whole-position average remains only as a documented fallback.

#### Scenario: Trigger levels within tolerance pass

- **WHEN** both legs' computed TP/SL triggers are within 100 bps of their expected per-leg fill-anchored levels and the cross-symmetry check holds within 100 bps
- **THEN** the protection orders are submitted normally

#### Scenario: Tolerance breach aborts protection loudly

- **WHEN** a computed trigger deviates from its expected fill-anchored level by more than 100 bps, or cross-symmetry fails beyond 100 bps
- **THEN** no protection order is placed, an urgent notification is sent, and the trade enters rollback / `failed` handling

#### Scenario: Corrupt RISEx position-average fill price fails loudly

- **WHEN** the RISEx hedge fill price resolves from `readPositionEntryPrice` to a blank or signed-size-fallback (blended) value and no true fill price is available
- **THEN** the protection step fails loudly (urgent notify + rollback / `failed`) instead of submitting mis-anchored TP/SL orders

### Requirement: Per-venue trigger price type

RISEx TP/SL orders SHALL use `MARK_PRICE` trigger price type (`stop_price_option: MarkPrice`) to stop wick-driven mis-fires, while Extended SHALL remain LAST-trigger-only with the existing 150 bps `MARKET_CROSSING_BUFFER_BPS` execution bound. Asymmetric trigger sources across venues are acceptable because both venues track the same BTC mark within normal basis.

#### Scenario: RISEx protection order uses mark-price trigger

- **WHEN** a TP or SL order is submitted to RISEx
- **THEN** the order payload sets `stop_price_option: MarkPrice`

#### Scenario: Extended protection order remains LAST-triggered

- **WHEN** a TP or SL order is submitted to Extended
- **THEN** the order uses `triggerPriceType: "LAST"` with the execution price bounded 150 bps past the trigger (`MARKET_CROSSING_BUFFER_BPS`)

### Requirement: Removal of spread-USD exits with time-stop and recovery sweep retained

The system SHALL remove all spread-USD exit comparisons (close-both-legs when live spread improves/degrades on captured spread by `OPEN_TRADE_SPREAD_TP_USD` / `OPEN_TRADE_SPREAD_SL_USD`). Config loading SHALL reject `OPEN_TRADE_SPREAD_TP_USD` and `OPEN_TRADE_SPREAD_SL_USD` as unknown variables (fail fast). The system SHALL retain the orthogonal 30-minute time-stop close (reason `spread_timeout`, config `OPEN_TRADE_SPREAD_EXIT_TIMEOUT_MINUTES` kept with default `30`) and the stale-`closing` recovery sweep in the monitor.

#### Scenario: Spread-USD env vars rejected at config load

- **WHEN** an environment defines `OPEN_TRADE_SPREAD_TP_USD` or `OPEN_TRADE_SPREAD_SL_USD`
- **THEN** `loadBotConfig` throws a clear unknown-variable error and the bot does not start

#### Scenario: No spread-USD comparisons run on open trades

- **WHEN** a trade is open and the spread moves favorably or adversely by any USD amount before the 30-minute timeout
- **THEN** no spread-USD close is triggered (time-stop and stale-`closing` recovery sweep remain active)

#### Scenario: Time-stop still closes open trades after 30 minutes

- **WHEN** an open trade has been open for `OPEN_TRADE_SPREAD_EXIT_TIMEOUT_MINUTES` (default 30) minutes
- **THEN** both legs are closed reduce-only with reason `spread_timeout`

### Requirement: Fee-aware fill-time edge band with immediate abort

At fill time the system SHALL compute the round-trip breakeven as entry fees + exit fees + slippage (entry/exit fee bps from `options.fees` per leg — maker bps for the limit leg, taker bps for the market leg — plus `OPEN_TRADE_SLIPPAGE_BPS` (default `2`) on exit notional, replacing the `EXIT_SLIPPAGE_BPS` constant). The trade SHALL be kept iff expected convergence (USD) ≥ breakeven + `OPEN_TRADE_MIN_PROFIT_USD` (default `$0.05`); otherwise the system SHALL immediately reduce-only close both legs via the existing `closeTradeBothLegs` path with reason `edge_below_cost`. The realized loss on the abort close SHALL be structurally bounded ≪ `OPEN_TRADE_MAX_LOSS_USD` (default `$0.25`), which SHALL also be enforced as a runtime assertion on the abort-close path (log/notify if exceeded). The dormant `edge_closed` `ConfirmOutcome` return path SHALL be reactivated and surfaced via Telegram.

#### Scenario: Fill with sufficient edge is kept

- **WHEN** expected convergence at fill is ≥ round-trip breakeven + `OPEN_TRADE_MIN_PROFIT_USD`
- **THEN** the trade proceeds to protection and remains open; no abort close occurs

#### Scenario: Fill below breakeven band is aborted immediately

- **WHEN** expected convergence at fill is < round-trip breakeven + `OPEN_TRADE_MIN_PROFIT_USD`
- **THEN** both legs are immediately closed reduce-only with reason `edge_below_cost`, the realized loss stays ≪ `OPEN_TRADE_MAX_LOSS_USD`, and an `edge_closed` Telegram notice is sent via the reactivated outcome path

#### Scenario: Abort loss exceeding max-loss band raises assertion

- **WHEN** an abort close (`edge_below_cost`) realizes a loss exceeding `OPEN_TRADE_MAX_LOSS_USD`
- **THEN** the runtime assertion fires and logs/notifies the operator (fee-model drift detected)

### Requirement: Edge-min-profit config replaced, not aliased

The system SHALL remove `OPEN_TRADE_EDGE_MIN_PROFIT_USD` and the `edgeMinProfitUsd` option entirely (no alias, no override behavior) and introduce `OPEN_TRADE_MIN_PROFIT_USD` (default `"0.05"`) as the single minimum-profit knob layered on round-trip breakeven. Config loading SHALL reject `OPEN_TRADE_EDGE_MIN_PROFIT_USD` as an unknown variable. `OPEN_TRADE_SLIPPAGE_BPS` SHALL be the env-driven replacement for the removed `EXIT_SLIPPAGE_BPS` constant. The updated surface SHALL be echoed in `formatActiveConfigSummary` and documented in `.env.example` and the `AGENTS.md` env table.

#### Scenario: Legacy edge-min-profit env var fails fast

- **WHEN** an environment defines `OPEN_TRADE_EDGE_MIN_PROFIT_USD` (e.g., the old default `"10"`)
- **THEN** `loadBotConfig` throws a clear unknown-variable error rather than silently applying a vetoing threshold

#### Scenario: New defaults applied without legacy vars

- **WHEN** config is loaded with none of the legacy vars set
- **THEN** `OPEN_TRADE_MIN_PROFIT_USD` is `0.05`, `OPEN_TRADE_MAX_LOSS_USD` is `0.25`, and `OPEN_TRADE_SLIPPAGE_BPS` is `2`
