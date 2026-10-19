# Feature: unhedged-pnl-sampling (Fase 2 del strategy-improvement agent)

Status: in progress — started 2026-10-19.
Roadmap: `docs/strategy-improvement-agent.md` phase 2 (unrealized-PnL sampling
during unhedged windows).

## Goal

While a trade is in status `unhedged` (one leg's TP/SL fired, the surviving
leg is naked), the bot samples the survivor's mark price and gross unrealized
PnL on a configurable interval and persists the time series. This turns
phase-1 outcome data (closed_at gaps) into intra-window paths: max favorable
excursion, near-TP-then-reversal detection, and the input the phase-5
backtest needs to evaluate SL-raise vs trailing-stop policies.

## Design decisions

- **New table** `unhedged_leg_samples` (time-series; reusing
  `trade_status_history.metadata` was rejected — samples are high-cardinality
  rows, not status transitions).
- **Sampling home**: the monitor pass in `polling-loop.ts` (runs on
  `PRICE_POLL_INTERVAL_MS`, already owns unhedged-trade handling, decoupled
  from the signal tick). Wired after `monitorTrades()`.
- **Mark price source**: `ExchangeAdapter.getPriceSnapshot` on the survivor
  leg's exchange, using the configured `MARKET_TYPE`/`PRICE_SOURCE` (fails
  closed per adapter when the source is missing).
- **Throttle**: `UNHEDGED_SAMPLE_INTERVAL_MS` (default 5000, `0` = disabled).
  Last-sample-per-trade read from the table (stateless, survives restart).
- **PnL convention**: GROSS mark-to-market vs the leg's own entry fill —
  `(mark − entry) × qty × (long ? 1 : −1)`; NULL when entry/qty unknown
  (never estimated), same always-gross rule as realized columns.
- **Denormalized snapshot columns** (entryPriceUsd, quantityBase) so rows are
  immutable even if the leg row later changes.
- **Retention**: pruned with the existing daily retention job by `sampledAt`
  (child table, plain batched delete — no FK-guard needed).
- **Backend**: read-only `GET /api/trades/:id/unhedged-samples` (service +
  normalizer + route, existing trade-analysis pattern) so the phase-4 offline
  agent never needs direct DB access.

## Tasks

- [x] 1. DB + config: `unhedged_leg_samples` table in schema.ts, migration
      0005 (drizzle-kit generate; guard: the generated SQL must contain ONLY
      the new table + indexes — stop if unrelated ALTERs appear), config
      `UNHEDGED_SAMPLE_INTERVAL_MS`, AGENTS.md config row. — DONE
      2026-10-19 (gentle-ai-worker): migration GENERATED clean
      (0005_fresh_amazoness.sql, only new table+FKs+indexes), generate
      re-run idempotent, typecheck exit 0. `parseNonNegativeInteger`,
      default 5000, 0 disables.
- [x] 2. Bot sampler: `apps/bot/src/trading/unhedged-sampler.ts`, wired into
      the monitor pass, per-trade error isolation, retention prune wiring,
      `specs/bot.md` section. — DONE 2026-10-19 (gentle-ai-worker): sampler
      after monitorTrades / before recoverStaleClosingTrades, per-leg warn
      isolation, throttle = latest sampledAt per trade, retention unguarded
      watermark prune by sampledAt. No deviations.
- [x] 3. Backend endpoint: `GET /api/trades/:id/unhedged-samples` (bounded
      limit, ascending order, iso() date guards), `specs/backend.md` section.
      — DONE 2026-10-19 (gentle-ai-worker): 404 contract parity with
      timeline, limit 1..5000 default 1000, trade-existence probe, samples
      ASC by (sampledAt, id), iso() zero-date guards. typecheck exit 0.
- [x] 4. Verification: `yarn typecheck` (root), gentle-ai-verify on the diff;
      record evidence here. — DONE 2026-10-19: typecheck exit 0 (twice, incl.
      after final edits); gentle-ai-verify 6/6 OK, no blockers (migration
      clean per guard, sampler sign/throttle/wiring verified, retention
      FK-safe, backend 404/limit/iso() verified). Minor non-blockers:
      throttle boundary `== interval` samples (acceptable); theoretical
      double-insert if a trade ever had two open|unhedged legs (impossible
      in practice — the closed leg is always excluded).
- [ ] 5. Close: roadmap phase 2 → implemented, Engram mirror, operator
      report (deploy steps: migrate + rebuild bot & backend). — roadmap
      updated (phase 2 = Implemented, pending deploy); native review
      APPROVED + burned 2026-10-19 (lineage review-468d87e746e8a8a8);
      3 informational follow-ups: R3-config-source-mismatch (sampler reads
      global priceSource/marketType), R3-retention-fk-ordering,
      R3-untested-sampler-behavior.

## Evidence

- (pending)
