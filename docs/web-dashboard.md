# Web dashboard

The web app is a read-only React dashboard for visualizing arbitrage operations. It does not place orders and does not mutate bot state.

## Quick path

Run the web in development:

```bash
COREPACK_ENABLE_AUTO_PIN=0 corepack yarn@4.5.3 dev:web
```

Dry-run is the default UI mode:

```bash
BOT_EXECUTION_MODE=dry-run COREPACK_ENABLE_AUTO_PIN=0 corepack yarn@4.5.3 dev:web
```

## Current dashboard

| Section | Status | Notes |
|---|---|---|
| Open operations | implemented | Uses dry-run mocks for now. |
| Operation legs | implemented | Shows both exchange legs for each arbitrage operation. |
| Net PnL | implemented | Combines gross PnL, fees, and funding across both legs. |
| Historical operations | placeholder | Planned for closed trade history. |

## Dry-run mocks

When `BOT_EXECUTION_MODE` is not `live`, the dashboard reads mock open operations from:

```txt
apps/web/src/features/dashboard/mock-operations.ts
```

Mock values intentionally include randomized:

- `unrealizedPnlUsd`
- `fundingUsd`

This lets the UI show positive and negative PnL states while real trade persistence and read-only API endpoints are still pending.

## PnL model

Each operation has two legs:

| Field | Meaning |
|---|---|
| `exchangeId` | Exchange for that leg. |
| `side` | `long` or `short`. |
| `entryPriceUsd` | Entry price for the leg. |
| `markPriceUsd` | Current mark price used for unrealized PnL. |
| `quantityBtc` | BTC size. |
| `notionalUsd` | Position notional. |
| `marginUsd` | Margin allocated to the leg. |
| `leverage` | Applied leverage. |
| `unrealizedPnlUsd` | Current leg PnL before fees/funding. |
| `feesUsd` | Fees attributed to the leg. |
| `fundingUsd` | Funding impact for the leg. |
| `liquidationPriceUsd` | Optional liquidation estimate. |

Net PnL is calculated in:

```txt
apps/web/src/features/dashboard/operations.ts
```

Formula:

```txt
netPnlUsd = grossPnlUsd - feesUsd + fundingUsd
```

## Component structure

Dashboard components follow one file per component:

```txt
apps/web/src/features/dashboard/components/
  EmptyState.tsx
  LegStat.tsx
  MetricCard.tsx
  OperationCard.tsx
  OperationLegPanel.tsx
  StatusBadge.tsx
  SummaryItem.tsx
```

Shared helpers live next to the feature:

```txt
dashboard-formatters.ts
dashboard-styles.ts
dashboard-types.ts
operations.ts
mock-operations.ts
```

## Tailwind v4

The web uses Tailwind CSS v4 with the official Vite plugin.

Key files:

```txt
apps/web/vite.config.ts
apps/web/src/styles/tailwind.css
```

There is no `tailwind.config.ts` and no `postcss.config.js`.

Semantic PnL tokens live in CSS:

```css
@theme {
  --color-profit: oklch(76% 0.19 154);
  --color-profit-border: oklch(52% 0.13 154);
  --color-loss: oklch(68% 0.22 25);
  --color-loss-border: oklch(51% 0.16 25);
}
```

Use semantic classes for financial state:

```txt
text-profit
border-profit-border
bg-profit-surface
text-loss
border-loss-border
bg-loss-surface
```

## Next slice

- Add read-only API endpoints for open trades.
- Replace dry-run mocks with API data outside dry-run mode.
- Implement historical operations with closed trades and realized PnL.
