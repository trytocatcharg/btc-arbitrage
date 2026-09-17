# Volume Stats API Specification

## Purpose

Expose persisted farmed volume to the read-only backend API and the web dashboard: a read-only volume-stats endpoint following the existing balances-route pattern, consumed by a farmed-volume panel on the dashboard's existing 30-second refresh.

## ADDED Requirements

### Requirement: Read-only volume-stats endpoint with service and normalizer pattern

The backend SHALL expose `GET /api/trades/volume-stats` in `apps/backend` (wired in `server.ts`), implemented with the same service + normalizer pattern as the balances routes (a stats service over the DB plus a normalized response shape). The endpoint SHALL be read-only: no mutation routes SHALL be added anywhere in the backend, and the route SHALL perform no order placement or exchange signing.

#### Scenario: Volume-stats endpoint returns a normalized response

- **WHEN** a client issues `GET /api/trades/volume-stats`
- **THEN** the backend responds with a normalized JSON payload served through a dedicated stats service and normalizer, matching the structural pattern of `/api/exchanges/balances`

#### Scenario: Backend exposes no mutation routes

- **WHEN** the backend route table is enumerated
- **THEN** only `GET` (read-only) routes exist, including `/api/trades/volume-stats` with no POST/PUT/PATCH/DELETE counterpart

### Requirement: Lifetime and trailing-window totals with per-venue breakdown

The volume-stats response SHALL include lifetime farmed-volume totals and trailing-window aggregations, each with a per-venue breakdown, sourced from the persisted `filled_notional_usd` columns on `trades` / `trade_legs` (not recomputed from transient runtime state).

#### Scenario: Lifetime totals include per-venue split

- **WHEN** `GET /api/trades/volume-stats` is called against a database with fills on both venues
- **THEN** the response includes lifetime farmed volume in USD broken down per venue (RISEx / Extended), consistent with the sum of `filled_notional_usd`

#### Scenario: Trailing-window aggregation reflects recent volume only

- **WHEN** `GET /api/trades/volume-stats` is called with trades older than the trailing window
- **THEN** the trailing-window totals exclude those trades' volume while lifetime totals include them

### Requirement: Web dashboard farmed-volume panel on the 30-second refresh

The web dashboard SHALL render a farmed-volume panel in `apps/web/src/features/dashboard/` (one component per file, following the balances panel pattern) fed by `GET {VITE_BACKEND_API_BASE_URL}/api/trades/volume-stats` on the existing 30-second refresh cadence. The web app SHALL remain read-only and SHALL NOT contain exchange signing logic or order-placement logic.

#### Scenario: Panel renders fetched volume stats

- **WHEN** the dashboard loads and the backend returns volume stats
- **THEN** the farmed-volume panel displays the lifetime and trailing-window totals with the per-venue breakdown

#### Scenario: Panel refreshes on the existing cadence

- **WHEN** the dashboard has been open for more than 30 seconds
- **THEN** the farmed-volume panel re-fetches and re-renders with current stats, alongside the existing balances refresh

#### Scenario: Web app introduces no signing or mutation capability

- **WHEN** the web app source is audited after this change
- **THEN** no exchange signing, credential handling, or mutating API calls are present; all volume data flows read-only from the backend
