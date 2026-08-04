# Database package

MariaDB persistence is managed with Drizzle ORM from this workspace.

## Drizzle commands

Run from the repository root:

```bash
yarn db:generate
yarn db:migrate
yarn db:studio
```

Or directly from this package:

```bash
yarn workspace @btc-arbitrage/db db:generate
yarn workspace @btc-arbitrage/db db:migrate
yarn workspace @btc-arbitrage/db db:studio
```


## SQL scripts

Manual SQL scripts live in `packages/db/scripts`.

For a fresh MariaDB database:

```bash
mariadb --host 127.0.0.1 --port 3306 --user user --password btc_arbitrage < packages/db/scripts/001_create_schema.sql
```

If the database already has a different schema, do not use this as a migration. Create an ALTER-only migration instead.

## Trade history model

- `trades`: one arbitrage trade lifecycle, including status, exchanges, leverage, spreads, PnL, fees, and open/close timestamps.
- `trade_legs`: long/short leg details per exchange, including entry/exit prices, quantities, order ids, fees, funding, and leg PnL.
- `trade_status_history`: immutable status transitions for auditability.
- `telegram_command_logs`: audit trail for future Telegram commands such as `/trades`.

Open trade states are exported as `openTradeStatuses` (`planned`, `open`, `closing`) so the bot can later suppress new alerts while a trade is active.
