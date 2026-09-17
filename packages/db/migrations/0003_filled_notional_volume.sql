-- Manual execution: remove lines containing "--> statement-breakpoint" before
-- running in a SQL client — they are Drizzle statement-split markers, not SQL.
ALTER TABLE `trades` ADD COLUMN `filled_notional_usd` decimal(24,8) NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `trade_legs` ADD COLUMN `filled_notional_usd` decimal(24,8) NOT NULL DEFAULT 0;
