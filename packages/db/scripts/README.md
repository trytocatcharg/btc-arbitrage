# SQL scripts

These SQL scripts are meant for MariaDB. They are safe to re-run for existing tables/indexes, but they do not patch schema drift.

## Apply schema manually

```bash
mariadb --host 127.0.0.1 --port 3306 --user user --password btc_arbitrage < packages/db/scripts/001_create_schema.sql
```

If the database already has a different schema, do not use this as a migration. Create an ALTER-only migration instead.
