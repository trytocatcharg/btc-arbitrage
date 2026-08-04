CREATE TABLE `events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`level` varchar(16) NOT NULL,
	`type` varchar(64) NOT NULL,
	`message` varchar(1024) NOT NULL,
	`related_entity_id` varchar(128),
	`metadata` json,
	`created_at` timestamp NOT NULL,
	CONSTRAINT `events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `operations` (
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
	CONSTRAINT `operations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `price_snapshots` (
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
--> statement-breakpoint
CREATE TABLE `signals` (
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
	CONSTRAINT `signals_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `spread_snapshots` (
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
--> statement-breakpoint
CREATE TABLE `telegram_command_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`chat_id` varchar(64) NOT NULL,
	`command` varchar(64) NOT NULL,
	`allowed` boolean NOT NULL,
	`response_summary` varchar(512),
	`created_at` timestamp NOT NULL,
	CONSTRAINT `telegram_command_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `trade_legs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`trade_id` int NOT NULL,
	`exchange_id` varchar(32) NOT NULL,
	`side` enum('long','short') NOT NULL,
	`status` enum('planned','submitted','open','closed','cancelled','failed') NOT NULL,
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
	`opened_at` timestamp,
	`closed_at` timestamp,
	`raw` json,
	CONSTRAINT `trade_legs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `trade_status_history` (
	`id` int AUTO_INCREMENT NOT NULL,
	`trade_id` int NOT NULL,
	`from_status` enum('planned','open','closing','closed','cancelled','failed'),
	`to_status` enum('planned','open','closing','closed','cancelled','failed') NOT NULL,
	`reason` varchar(512),
	`metadata` json,
	`changed_at` timestamp NOT NULL,
	CONSTRAINT `trade_status_history_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `trades` (
	`id` int AUTO_INCREMENT NOT NULL,
	`signal_id` int,
	`symbol` varchar(32) NOT NULL,
	`market_type` varchar(32) NOT NULL,
	`price_source` varchar(16) NOT NULL,
	`mode` varchar(16) NOT NULL,
	`status` enum('planned','open','closing','closed','cancelled','failed') NOT NULL,
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
	CONSTRAINT `trades_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `operations` ADD CONSTRAINT `operations_signal_id_signals_id_fk` FOREIGN KEY (`signal_id`) REFERENCES `signals`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `operations` ADD CONSTRAINT `operations_trade_id_trades_id_fk` FOREIGN KEY (`trade_id`) REFERENCES `trades`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `signals` ADD CONSTRAINT `signals_spread_id_spread_snapshots_id_fk` FOREIGN KEY (`spread_id`) REFERENCES `spread_snapshots`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `trade_legs` ADD CONSTRAINT `trade_legs_trade_id_trades_id_fk` FOREIGN KEY (`trade_id`) REFERENCES `trades`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `trade_status_history` ADD CONSTRAINT `trade_status_history_trade_id_trades_id_fk` FOREIGN KEY (`trade_id`) REFERENCES `trades`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `trades` ADD CONSTRAINT `trades_signal_id_signals_id_fk` FOREIGN KEY (`signal_id`) REFERENCES `signals`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `event_type_created_at_idx` ON `events` (`type`,`created_at`);--> statement-breakpoint
CREATE INDEX `event_level_created_at_idx` ON `events` (`level`,`created_at`);--> statement-breakpoint
CREATE INDEX `operation_signal_idx` ON `operations` (`signal_id`);--> statement-breakpoint
CREATE INDEX `operation_trade_idx` ON `operations` (`trade_id`);--> statement-breakpoint
CREATE INDEX `operation_status_created_at_idx` ON `operations` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `price_exchange_symbol_idx` ON `price_snapshots` (`exchange_id`,`symbol`);--> statement-breakpoint
CREATE INDEX `signal_status_created_at_idx` ON `signals` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `signal_spread_idx` ON `signals` (`spread_id`);--> statement-breakpoint
CREATE INDEX `spread_symbol_calculated_at_idx` ON `spread_snapshots` (`symbol`,`calculated_at`);--> statement-breakpoint
CREATE INDEX `spread_matched_calculated_at_idx` ON `spread_snapshots` (`threshold_matched`,`calculated_at`);--> statement-breakpoint
CREATE INDEX `telegram_command_chat_created_at_idx` ON `telegram_command_logs` (`chat_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `telegram_command_command_created_at_idx` ON `telegram_command_logs` (`command`,`created_at`);--> statement-breakpoint
CREATE INDEX `trade_leg_trade_idx` ON `trade_legs` (`trade_id`);--> statement-breakpoint
CREATE INDEX `trade_leg_exchange_status_idx` ON `trade_legs` (`exchange_id`,`status`);--> statement-breakpoint
CREATE INDEX `trade_leg_trade_side_idx` ON `trade_legs` (`trade_id`,`side`);--> statement-breakpoint
CREATE INDEX `trade_status_history_trade_changed_at_idx` ON `trade_status_history` (`trade_id`,`changed_at`);--> statement-breakpoint
CREATE INDEX `trade_status_history_to_status_changed_at_idx` ON `trade_status_history` (`to_status`,`changed_at`);--> statement-breakpoint
CREATE INDEX `trade_status_created_at_idx` ON `trades` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `trade_status_opened_at_idx` ON `trades` (`status`,`opened_at`);--> statement-breakpoint
CREATE INDEX `trade_signal_idx` ON `trades` (`signal_id`);--> statement-breakpoint
CREATE INDEX `trade_symbol_status_idx` ON `trades` (`symbol`,`status`);