-- Open Trade preview, execution-state and leg-monitoring support.
ALTER TABLE `trades` MODIFY COLUMN `status` enum('awaiting_confirmation','executing_limit','hedging','protecting','open','closing','unhedged','closed','cancelled','failed') NOT NULL;
ALTER TABLE `trade_legs` MODIFY COLUMN `status` enum('planned','submitted','open','unhedged','closed','cancelled','failed') NOT NULL;
ALTER TABLE `trade_legs` ADD COLUMN `close_reason` varchar(32) AFTER `exit_order_id`;
ALTER TABLE `trade_legs` ADD COLUMN `closure_notified_at` timestamp NULL AFTER `close_reason`;
CREATE TABLE `trade_previews` (
  `id` int AUTO_INCREMENT NOT NULL,
  `signal_id` int NOT NULL,
  `trade_id` int,
  `token` varchar(96) NOT NULL,
  `status` varchar(32) NOT NULL,
  `expires_at` timestamp NOT NULL,
  `consumed_at` timestamp,
  `payload` json NOT NULL,
  `created_at` timestamp NOT NULL,
  `updated_at` timestamp NOT NULL,
  CONSTRAINT `trade_previews_id` PRIMARY KEY(`id`),
  CONSTRAINT `trade_previews_signal_id_signals_id_fk` FOREIGN KEY (`signal_id`) REFERENCES `signals`(`id`) ON DELETE no action ON UPDATE no action,
  CONSTRAINT `trade_previews_trade_id_trades_id_fk` FOREIGN KEY (`trade_id`) REFERENCES `trades`(`id`) ON DELETE no action ON UPDATE no action
);
CREATE INDEX `trade_preview_token_idx` ON `trade_previews` (`token`);
CREATE INDEX `trade_preview_signal_status_idx` ON `trade_previews` (`signal_id`,`status`);
