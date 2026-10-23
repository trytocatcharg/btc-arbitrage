-- Hand-written like 0004: drizzle-kit generate cannot be trusted here
-- (snapshot drift in migrations/meta makes it re-emit statements for existing
-- tables). Only the new table belongs in this migration; IF NOT EXISTS keeps
-- it idempotent.
--
-- Gold/silver ratio monitor (v1 monitor-only): one row per ratio tick computed
-- from Arcus GLD-USD / SLV-USD perp prices. `rsi` stays NULL until enough
-- candle closes exist for the configured period; `side` holds the
-- MetalRatioSide value only on ticks where the RSI leaves the dead zone around
-- 50; `crossed` is true only when that side changed vs the previous tick.
-- `calculated_at` carries an explicit DEFAULT (now()) so MariaDB's implicit
-- TIMESTAMP attribute quirk (fixed repo-wide in 0002) cannot re-apply.
CREATE TABLE IF NOT EXISTS `ratio_snapshots` (
	`id` int AUTO_INCREMENT NOT NULL,
	`gold_price_usd` decimal(24,8) NOT NULL,
	`silver_price_usd` decimal(24,8) NOT NULL,
	`ratio` decimal(24,8) NOT NULL,
	`rsi` decimal(12,4),
	`side` varchar(32),
	`crossed` boolean NOT NULL DEFAULT false,
	`calculated_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ratio_snapshots_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `ratio_calculated_at_idx` ON `ratio_snapshots` (`calculated_at`);
