# Volume Farming Specification

## Purpose

Make farmed trading volume — the bot's primary objective — a first-class, persisted, operator-visible quantity: accumulated monotonically in the database at every fill writer, and surfaced in Telegram summaries.

## Requirements

### Requirement: Filled-notional volume columns on trades and trade_legs

The database schema SHALL carry `filled_notional_usd decimal(24,8) not null default 0` on both `trades` (required; cumulative per-trade farmed volume) and `trade_legs` (per-leg granularity for debugging and per-venue splits). No new enum values SHALL be added to `trades.status` or `trade_legs.status`.

#### Scenario: Fresh and existing databases carry the columns

- **WHEN** migration 0003 is applied on a fresh database or on an existing database with prior trades
- **THEN** both tables gain `filled_notional_usd decimal(24,8) not null default 0`, existing rows read as zero without a backfill, and no status enum values change

### Requirement: Hand-written additive migration 0003

The migration SHALL be a hand-written `packages/db/migrations/0003_*.sql` containing additive `ALTER TABLE ... ADD COLUMN` statements only. `drizzle-kit generate` SHALL NOT be used for this migration (migration-drift landmine: `migrations/meta/` snapshot parity cannot be trusted).

#### Scenario: Migration contains additive column statements only

- **WHEN** `packages/db/migrations/0003_*.sql` is inspected
- **THEN** it contains only `ALTER TABLE` add-column statements for the two volume columns and no generated diff content, enum changes, or data transformations

### Requirement: Monotonic coalesce-plus-delta increments inside writers' existing transactions

Farmed volume SHALL be accumulated monotonically as `filled_notional_usd = coalesce(filled_notional_usd, 0) + :delta` inside the existing transactions of the three existing writers, so concurrent or crashy paths cannot lose volume. The increments SHALL be:

- `db-preview-store.ts` `transition()` / `runEntry` fill loop — limit leg: `settledNotionalUsd` (exact across reprices); hedge leg: `qty × hedge.averageFillPriceUsd`.
- `trade-close.ts` — close fills: `qty × ack.averageFillPriceUsd` (with the existing position-derived exit-price fallback in step 3).
- `trade-monitor.ts` — venue-side TP/SL closures where only exit price is known: `qty × exitPrice`.

#### Scenario: Entry and hedge fills increment volume inside the entry transaction

- **WHEN** a trade is confirmed and the limit leg fills (possibly across reprices) and the hedge fills
- **THEN** within the same DB transaction, the limit leg's `trade_legs.filled_notional_usd` increases by the settled limit notional and the hedge leg's increases by hedge `qty × averageFillPriceUsd`, with the trade-level column reflecting the sum

#### Scenario: Close fills increment volume inside the close transaction

- **WHEN** `trade-close.ts` closes legs with market orders acknowledged at `averageFillPriceUsd`
- **THEN** each leg's and the trade's `filled_notional_usd` increases by `qty × ack.averageFillPriceUsd` inside the close transaction

#### Scenario: Venue-side TP/SL closure increments volume inside the monitor transaction

- **WHEN** `trade-monitor.ts` detects a venue-side TP/SL closure with a known exit price
- **THEN** the corresponding leg's and the trade's `filled_notional_usd` increases by `qty × exitPrice` inside the monitor's existing transaction

#### Scenario: Concurrent increments do not lose volume

- **WHEN** two writers increment the same `filled_notional_usd` column in overlapping windows
- **THEN** both deltas are applied (coalesce + delta inside each writer's transaction) and no update is silently overwritten

### Requirement: Farmed volume surfaced in Telegram notices

The system SHALL surface farmed volume in three Telegram surfaces: a farmed-volume line in the fill summary (`buildFillSummary` in `telegram-command-poller.ts`), a cumulative farmed-volume line in the trade close notice (`trade-close.ts`), and a DB-backed lifetime/period farmed-volume line in the `/summary` command (`trade-summary.ts`, replacing or augmenting the current live-price "Total notional" estimate with a persisted value).

#### Scenario: Fill summary includes farmed volume

- **WHEN** the opened-trade fill summary message is built after entry and hedge fills
- **THEN** the message includes a farmed-volume line sourced from the persisted `filled_notional_usd`

#### Scenario: Close notice shows cumulative volume

- **WHEN** a trade closes and the final close notice is sent
- **THEN** the notice includes the trade's cumulative farmed volume at close

#### Scenario: /summary shows DB-backed farmed volume

- **WHEN** the operator issues `/summary`
- **THEN** the response includes a farmed-volume line sourced from the database (lifetime/period totals), not merely estimated from live prices
