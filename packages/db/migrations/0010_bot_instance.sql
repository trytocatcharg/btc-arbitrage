-- Hand-written like 0007/0008/0009: drizzle-kit generate cannot be trusted
-- here (snapshot drift in migrations/meta makes it re-emit statements for
-- existing tables). Only the bot_instance column addition belongs in this
-- migration.
--
-- Bot instance split (design approved by operator 2026-11-12,
-- odd/tasks/bot-instance-split.md): two bot processes (BTC spread strategy
-- and the Arcus-pair metal strategy) run against the SAME database and are
-- scoped by an explicit ownership column instead of deriving ownership from
-- the trade symbol. This is the enabler migration; the code-side filters
-- deploy afterwards and are harmless while the single legacy bot runs.
--
-- Instance ids baked into the backfill (confirmed with the operator):
--   'btc'   — spread strategy (BTCUSDT + /arb screener trades)
--   'metal' — Arcus-pair strategies (GOLDSILVER, SPYQQQ)
-- Existing rows from the pre-split single bot stay 'legacy' where they
-- cannot be attributed (telegram_command_logs).
ALTER TABLE `trades` ADD COLUMN `bot_instance` varchar(32) NOT NULL DEFAULT 'legacy';
ALTER TABLE `trade_previews` ADD COLUMN `bot_instance` varchar(32) NOT NULL DEFAULT 'legacy';
ALTER TABLE `telegram_command_logs` ADD COLUMN `bot_instance` varchar(32) NOT NULL DEFAULT 'legacy';
ALTER TABLE `bot_runtime_overrides` ADD COLUMN `bot_instance` varchar(32) NOT NULL DEFAULT 'legacy';

-- Backfill trades by strategy symbol (SPYQQQ added on top of the original
-- plan sketch, which predates the SPY/QQQ strategy).
UPDATE `trades` SET `bot_instance` = 'metal' WHERE `symbol` IN ('GOLDSILVER', 'SPYQQQ');
UPDATE `trades` SET `bot_instance` = 'btc' WHERE `symbol` NOT IN ('GOLDSILVER', 'SPYQQQ');

-- Backfill previews from their parent trade where one exists; signal-driven
-- BTC previews (no trade yet) default to 'btc'.
UPDATE `trade_previews` `p` JOIN `trades` `t` ON `t`.`id` = `p`.`trade_id`
  SET `p`.`bot_instance` = `t`.`bot_instance`
  WHERE `p`.`trade_id` IS NOT NULL;
UPDATE `trade_previews` SET `bot_instance` = 'btc' WHERE `bot_instance` = 'legacy';

-- Backfill runtime overrides: metal* and etf* keys belong to the metal
-- instance (etf* = SPY/QQQ settings), everything else to the BTC instance.
UPDATE `bot_runtime_overrides` SET `bot_instance` = 'metal'
  WHERE `setting_key` LIKE 'metal%' OR `setting_key` LIKE 'etf%';
UPDATE `bot_runtime_overrides` SET `bot_instance` = 'btc' WHERE `bot_instance` = 'legacy';

-- Per-instance overrides: one row per (setting, instance).
ALTER TABLE `bot_runtime_overrides` DROP PRIMARY KEY,
  ADD PRIMARY KEY (`setting_key`, `bot_instance`);

-- Index for the instance-scoped monitor/guard queries that replace the
-- current symbol-based ownership filters (bot_instance, status).
ALTER TABLE `trades` ADD INDEX `trade_instance_status_idx` (`bot_instance`, `status`);
