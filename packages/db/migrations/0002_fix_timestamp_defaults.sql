-- Fix MariaDB implicit TIMESTAMP attributes.
--
-- MariaDB ships with explicit_defaults_for_timestamp=OFF, which silently coerces
-- bare `timestamp` column definitions at table creation:
--   * the FIRST timestamp column of a table gets
--     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, and
--   * later NOT NULL timestamp columns without an explicit default get
--     DEFAULT '0000-00-00 00:00:00'.
--
-- The drizzle migrations declare bare `timestamp` columns, so the physical
-- schema drifted from packages/db/src/schema.ts. Observable damage:
--   * trade_legs.closure_notified_at was never NULL  -> the position monitor's
--     isNull(closureNotifiedAt) filter matched nothing, so leg-closure
--     detection / unhedged alerts never ran;
--   * trades.opened_at ON UPDATE CURRENT_TIMESTAMP  -> the real open time was
--     overwritten on every trade row update;
--   * trade_previews.expires_at ON UPDATE CURRENT_TIMESTAMP  -> preview expiry
--     was bumped on every preview row update (retry/consume), breaking TTL;
--   * zero-dates parse as Invalid Date in the Node driver.
--
-- Re-declare every affected column explicitly to match the ORM schema.
-- Explicit NULL / DEFAULT clauses also prevent the quirk from re-applying.
--> statement-breakpoint
ALTER TABLE `events` MODIFY COLUMN `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP;
--> statement-breakpoint
ALTER TABLE `operations` MODIFY COLUMN `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP;
--> statement-breakpoint
ALTER TABLE `price_snapshots` MODIFY COLUMN `exchange_timestamp` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP;
--> statement-breakpoint
ALTER TABLE `price_snapshots` MODIFY COLUMN `received_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP;
--> statement-breakpoint
ALTER TABLE `signals` MODIFY COLUMN `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP;
--> statement-breakpoint
ALTER TABLE `spread_snapshots` MODIFY COLUMN `calculated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP;
--> statement-breakpoint
ALTER TABLE `telegram_command_logs` MODIFY COLUMN `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP;
--> statement-breakpoint
ALTER TABLE `trades` MODIFY COLUMN `opened_at` timestamp NULL;
--> statement-breakpoint
ALTER TABLE `trades` MODIFY COLUMN `closed_at` timestamp NULL;
--> statement-breakpoint
ALTER TABLE `trades` MODIFY COLUMN `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP;
--> statement-breakpoint
ALTER TABLE `trades` MODIFY COLUMN `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP;
--> statement-breakpoint
ALTER TABLE `trade_legs` MODIFY COLUMN `closure_notified_at` timestamp NULL;
--> statement-breakpoint
ALTER TABLE `trade_legs` MODIFY COLUMN `opened_at` timestamp NULL;
--> statement-breakpoint
ALTER TABLE `trade_legs` MODIFY COLUMN `closed_at` timestamp NULL;
--> statement-breakpoint
-- The app always sets expires_at explicitly; the explicit default only keeps
-- MariaDB's implicit-attribute quirk away from this column.
ALTER TABLE `trade_previews` MODIFY COLUMN `expires_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP;
--> statement-breakpoint
ALTER TABLE `trade_previews` MODIFY COLUMN `consumed_at` timestamp NULL;
--> statement-breakpoint
ALTER TABLE `trade_previews` MODIFY COLUMN `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP;
--> statement-breakpoint
ALTER TABLE `trade_previews` MODIFY COLUMN `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP;
--> statement-breakpoint
ALTER TABLE `trade_status_history` MODIFY COLUMN `changed_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP;
