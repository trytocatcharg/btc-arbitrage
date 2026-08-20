# Web specification

## Purpose

`apps/web` is a **read-only dashboard**.

It visualizes balances and open-operation style information, but it does **not** place orders and does **not** confirm trades.

## Runtime

- Entry point: `apps/web/src/main.tsx`
- Main screen: `apps/web/src/features/dashboard/Dashboard.tsx`
- Balance fetcher: `apps/web/src/features/dashboard/exchange-balances.ts`

The web app is a Vite + React application with Tailwind CSS v4.

## Current responsibilities

### 1. Show execution mode

The dashboard resolves execution mode from:

- `import.meta.env.BOT_EXECUTION_MODE`

Vite is configured with:

- `envPrefix: ['VITE_', 'BOT_']`

so `BOT_EXECUTION_MODE` is available to the frontend runtime.

### 2. Show exchange balances

The dashboard polls backend balances every 30 seconds from:

- `GET /api/exchanges/balances`

It renders cards for:

- RISEx
- Extended

If the backend call fails, the UI shows a visible error state.

### 3. Show open operations section

Current behavior:

- if execution mode is `dry-run`, the dashboard shows mock open operations,
- if execution mode is `live`, the dashboard currently shows no mock operations.

Mock data lives in:

- `apps/web/src/features/dashboard/mock-operations.ts`

## Current UI sections

Implemented:

- execution-mode header,
- RISEx balance card,
- Extended balance card,
- open operations,
- net open PnL summary,
- placeholder historical operations section.

## Architecture boundaries

The web must remain:

- read-only,
- non-executable,
- free of exchange signing logic,
- free of Telegram confirmation logic.

It must not:

- open long/short positions,
- confirm trade previews,
- place TP/SL,
- mutate bot state directly.

## Backend dependency

The dashboard depends on the backend for balances.

Base URL resolution:

- `VITE_BACKEND_API_BASE_URL` if configured,
- otherwise defaults to local backend assumptions.

## Non-goals

The web currently does **not** implement:

- real live trade list from DB/API,
- closed-trade history,
- order-entry forms,
- execution controls,
- trade confirmation UI.
