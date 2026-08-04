# Architecture rules

This document captures project-level decisions that future code must follow.

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
