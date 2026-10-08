-- Hand-written: drizzle-kit generate could not be trusted here (snapshot drift
-- in migrations/meta made it re-emit statements for existing tables). Only the
-- new table belongs in this migration; IF NOT EXISTS keeps it idempotent.
CREATE TABLE IF NOT EXISTS `bot_runtime_overrides` (
	`setting_key` varchar(32) NOT NULL,
	`setting_value` varchar(64) NOT NULL,
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `bot_runtime_overrides_setting_key` PRIMARY KEY(`setting_key`)
);
