# Architecture rules

This document captures project-level decisions that future code must follow.

## Runtime domain constants

Shared runtime values must live in `packages/domain`.

Example:

```ts
import { ExecutionMode } from '@btc-arbitrage/domain';

if (executionMode === ExecutionMode.DryRun) {
  // dry-run behavior
}
```

Do not duplicate runtime string literals such as `dry-run` or `live` in app code. The literal values belong in the domain enum only.

## Database access

All application code must access MariaDB through the shared `getDb()` helper from the DB package.

```ts
import { getDb, priceSnapshots } from '@btc-arbitrage/db';

const db = await getDb();
const rows = await db.select().from(priceSnapshots);
```

Do not create ad-hoc MySQL pools or connections inside bot/web features. Centralizing DB access keeps connection lifecycle, Drizzle schema usage, and future repository behavior consistent.

## Checklist for DB changes

- [ ] Use `getDb()` before any query.
- [ ] Import tables from `@btc-arbitrage/db`.
- [ ] Do not instantiate `mysql.createPool()` or `mysql.createConnection()` in feature code.
- [ ] Keep schema changes in `packages/db/src/schema.ts` and SQL scripts/migrations in `packages/db`.

## Web dashboard structure

The web dashboard follows one component per file.

```txt
apps/web/src/features/dashboard/components/
  OperationCard.tsx
  OperationLegPanel.tsx
  MetricCard.tsx
```

Feature helpers stay outside component files:

```txt
dashboard-formatters.ts
dashboard-styles.ts
dashboard-types.ts
operations.ts
mock-operations.ts
```

Do not reintroduce multiple React components into `Dashboard.tsx`. `Dashboard.tsx` should compose the screen.

React components must be declared as typed functional components:

```tsx
import type { FC } from 'react';

interface MetricCardProps {
  label: string;
}

export const MetricCard: FC<MetricCardProps> = ({ label }) => {
  return <article>{label}</article>;
};
```

Pure helpers can remain regular functions.

## Tailwind CSS

The web uses Tailwind CSS v4 with the official Vite plugin.

- Configure Tailwind through CSS-first tokens in `apps/web/src/styles/tailwind.css`.
- Keep `apps/web/vite.config.ts` using `@tailwindcss/vite`.
- Do not add `tailwind.config.ts` or `postcss.config.js` back unless there is a specific Tailwind v4 reason.
- Use semantic financial tokens for PnL: `profit`, `profit-border`, `loss`, `loss-border`.

## Package manager metadata

The root `package.json` intentionally has no `packageManager` field.

When running Corepack commands, use explicit Yarn version plus auto-pin disabled:

```bash
COREPACK_ENABLE_AUTO_PIN=0 corepack yarn@4.5.3 install
```

Do not let tooling add `packageManager` automatically.
