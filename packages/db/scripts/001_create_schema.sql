-- SQL schema for a fresh MariaDB database.
-- Select/create the target database before running this script.
-- Safe to re-run for existing tables/indexes, but it does not patch schema drift.

CREATE TABLE IF NOT EXISTS `events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`level` varchar(16) NOT NULL,
	`type` varchar(64) NOT NULL,
	`message` varchar(1024) NOT NULL,
	`related_entity_id` varchar(128),
	`metadata` json,
	`created_at` timestamp NOT NULL,
	CONSTRAINT `events_id` PRIMARY KEY(`id`)
);

CREATE TABLE IF NOT EXISTS `price_snapshots` (
	`id` int AUTO_INCREMENT NOT NULL,
	`exchange_id` varchar(32) NOT NULL,
	`symbol` varchar(32) NOT NULL,
	`external_market_id` varchar(128),
	`market_type` varchar(32) NOT NULL,
	`price_source` varchar(16) NOT NULL,
	`price_usd` decimal(24,8) NOT NULL,
	`bid_usd` decimal(24,8),
	`ask_usd` decimal(24,8),
	`exchange_timestamp` timestamp NOT NULL,
	`received_at` timestamp NOT NULL,
	`raw` json,
	CONSTRAINT `price_snapshots_id` PRIMARY KEY(`id`)
);

CREATE TABLE IF NOT EXISTS `spread_snapshots` (
	`id` int AUTO_INCREMENT NOT NULL,
	`symbol` varchar(32) NOT NULL,
	`market_type` varchar(32) NOT NULL,
	`price_source` varchar(16) NOT NULL,
	`exchange_a` varchar(32) NOT NULL,
	`exchange_b` varchar(32) NOT NULL,
	`exchange_a_price_usd` decimal(24,8) NOT NULL,
	`exchange_b_price_usd` decimal(24,8) NOT NULL,
	`absolute_diff_usd` decimal(24,8) NOT NULL,
	`diff_bps` decimal(24,8) NOT NULL,
	`direction` varchar(32) NOT NULL,
	`threshold_usd` decimal(24,8) NOT NULL,
	`threshold_matched` boolean NOT NULL,
	`calculated_at` timestamp NOT NULL,
	CONSTRAINT `spread_snapshots_id` PRIMARY KEY(`id`)
);

CREATE TABLE IF NOT EXISTS `signals` (
	`id` int AUTO_INCREMENT NOT NULL,
	`spread_id` int,
	`long_exchange` varchar(32) NOT NULL,
	`short_exchange` varchar(32) NOT NULL,
	`source` varchar(32) NOT NULL,
	`leverage` int NOT NULL,
	`threshold_usd` decimal(24,8) NOT NULL,
	`observed_diff_usd` decimal(24,8) NOT NULL,
	`reason` varchar(512) NOT NULL,
	`status` varchar(32) NOT NULL,
	`created_at` timestamp NOT NULL,
	CONSTRAINT `signals_id` PRIMARY KEY(`id`),
	CONSTRAINT `signals_spread_id_spread_snapshots_id_fk` FOREIGN KEY (`spread_id`) REFERENCES `spread_snapshots`(`id`) ON DELETE no action ON UPDATE no action
);

CREATE TABLE IF NOT EXISTS `trades` (
	`id` int AUTO_INCREMENT NOT NULL,
	`signal_id` int,
	`symbol` varchar(32) NOT NULL,
	`market_type` varchar(32) NOT NULL,
	`price_source` varchar(16) NOT NULL,
	`mode` varchar(16) NOT NULL,
	`status` enum('awaiting_confirmation','executing_limit','hedging','protecting','open','closing','unhedged','closed','cancelled','failed') NOT NULL,
	`long_exchange` varchar(32) NOT NULL,
	`short_exchange` varchar(32) NOT NULL,
	`leverage` int NOT NULL,
	`entry_spread_usd` decimal(24,8),
	`exit_spread_usd` decimal(24,8),
	`realized_pnl_usd` decimal(24,8),
	`unrealized_pnl_usd` decimal(24,8),
	`total_fees_usd` decimal(24,8),
	`opened_at` timestamp,
	`closed_at` timestamp,
	`created_at` timestamp NOT NULL,
	`updated_at` timestamp NOT NULL,
	CONSTRAINT `trades_id` PRIMARY KEY(`id`),
	CONSTRAINT `trades_signal_id_signals_id_fk` FOREIGN KEY (`signal_id`) REFERENCES `signals`(`id`) ON DELETE no action ON UPDATE no action
);

CREATE TABLE IF NOT EXISTS `trade_legs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`trade_id` int NOT NULL,
	`exchange_id` varchar(32) NOT NULL,
	`side` enum('long','short') NOT NULL,
	`status` enum('planned','submitted','open','unhedged','closed','cancelled','failed') NOT NULL,
	`entry_price_usd` decimal(24,8),
	`exit_price_usd` decimal(24,8),
	`quantity_base` decimal(24,10),
	`quantity_usd` decimal(24,8),
	`entry_fee_usd` decimal(24,8),
	`exit_fee_usd` decimal(24,8),
	`funding_fee_usd` decimal(24,8),
	`realized_pnl_usd` decimal(24,8),
	`external_position_id` varchar(128),
	`entry_order_id` varchar(128),
	`exit_order_id` varchar(128),
	`close_reason` varchar(32),
	`closure_notified_at` timestamp,
	`opened_at` timestamp,
	`closed_at` timestamp,
	`raw` json,
	CONSTRAINT `trade_legs_id` PRIMARY KEY(`id`),
	CONSTRAINT `trade_legs_trade_id_trades_id_fk` FOREIGN KEY (`trade_id`) REFERENCES `trades`(`id`) ON DELETE no action ON UPDATE no action
);

CREATE TABLE IF NOT EXISTS `trade_previews` (
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

CREATE TABLE IF NOT EXISTS `trade_status_history` (
	`id` int AUTO_INCREMENT NOT NULL,
	`trade_id` int NOT NULL,
	`from_status` enum('planned','open','closing','closed','cancelled','failed'),
	`to_status` enum('planned','open','closing','closed','cancelled','failed') NOT NULL,
	`reason` varchar(512),
	`metadata` json,
	`changed_at` timestamp NOT NULL,
	CONSTRAINT `trade_status_history_id` PRIMARY KEY(`id`),
	CONSTRAINT `trade_status_history_trade_id_trades_id_fk` FOREIGN KEY (`trade_id`) REFERENCES `trades`(`id`) ON DELETE no action ON UPDATE no action
);

CREATE TABLE IF NOT EXISTS `telegram_command_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`chat_id` varchar(64) NOT NULL,
	`command` varchar(64) NOT NULL,
	`allowed` boolean NOT NULL,
	`response_summary` varchar(512),
	`created_at` timestamp NOT NULL,
	CONSTRAINT `telegram_command_logs_id` PRIMARY KEY(`id`)
);

CREATE TABLE IF NOT EXISTS `operations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`signal_id` int,
	`trade_id` int,
	`mode` varchar(16) NOT NULL,
	`symbol` varchar(32) NOT NULL,
	`leverage` int NOT NULL,
	`status` varchar(32) NOT NULL,
	`guardrail_reason` varchar(512),
	`legs` json,
	`created_at` timestamp NOT NULL,
	CONSTRAINT `operations_id` PRIMARY KEY(`id`),
	CONSTRAINT `operations_signal_id_signals_id_fk` FOREIGN KEY (`signal_id`) REFERENCES `signals`(`id`) ON DELETE no action ON UPDATE no action,
	CONSTRAINT `operations_trade_id_trades_id_fk` FOREIGN KEY (`trade_id`) REFERENCES `trades`(`id`) ON DELETE no action ON UPDATE no action
);

CREATE INDEX IF NOT EXISTS `event_type_created_at_idx` ON `events` (`type`,`created_at`);
CREATE INDEX IF NOT EXISTS `event_level_created_at_idx` ON `events` (`level`,`created_at`);
CREATE INDEX IF NOT EXISTS `price_exchange_symbol_idx` ON `price_snapshots` (`exchange_id`,`symbol`);
CREATE INDEX IF NOT EXISTS `spread_symbol_calculated_at_idx` ON `spread_snapshots` (`symbol`,`calculated_at`);
CREATE INDEX IF NOT EXISTS `spread_matched_calculated_at_idx` ON `spread_snapshots` (`threshold_matched`,`calculated_at`);
CREATE INDEX IF NOT EXISTS `signal_status_created_at_idx` ON `signals` (`status`,`created_at`);
CREATE INDEX IF NOT EXISTS `signal_spread_idx` ON `signals` (`spread_id`);
CREATE INDEX IF NOT EXISTS `trade_status_created_at_idx` ON `trades` (`status`,`created_at`);
CREATE INDEX IF NOT EXISTS `trade_status_opened_at_idx` ON `trades` (`status`,`opened_at`);
CREATE INDEX IF NOT EXISTS `trade_signal_idx` ON `trades` (`signal_id`);
CREATE INDEX IF NOT EXISTS `trade_symbol_status_idx` ON `trades` (`symbol`,`status`);
CREATE INDEX IF NOT EXISTS `trade_preview_token_idx` ON `trade_previews` (`token`);
CREATE INDEX IF NOT EXISTS `trade_preview_signal_status_idx` ON `trade_previews` (`signal_id`,`status`);
CREATE INDEX IF NOT EXISTS `trade_leg_trade_idx` ON `trade_legs` (`trade_id`);
CREATE INDEX IF NOT EXISTS `trade_leg_exchange_status_idx` ON `trade_legs` (`exchange_id`,`status`);
CREATE INDEX IF NOT EXISTS `trade_leg_trade_side_idx` ON `trade_legs` (`trade_id`,`side`);
CREATE INDEX IF NOT EXISTS `trade_status_history_trade_changed_at_idx` ON `trade_status_history` (`trade_id`,`changed_at`);
CREATE INDEX IF NOT EXISTS `trade_status_history_to_status_changed_at_idx` ON `trade_status_history` (`to_status`,`changed_at`);
CREATE INDEX IF NOT EXISTS `telegram_command_chat_created_at_idx` ON `telegram_command_logs` (`chat_id`,`created_at`);
CREATE INDEX IF NOT EXISTS `telegram_command_command_created_at_idx` ON `telegram_command_logs` (`command`,`created_at`);
CREATE INDEX IF NOT EXISTS `operation_signal_idx` ON `operations` (`signal_id`);
CREATE INDEX IF NOT EXISTS `operation_trade_idx` ON `operations` (`trade_id`);
CREATE INDEX IF NOT EXISTS `operation_status_created_at_idx` ON `operations` (`status`,`created_at`);
