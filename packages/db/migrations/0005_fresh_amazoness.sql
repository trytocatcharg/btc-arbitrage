CREATE TABLE `unhedged_leg_samples` (
	`id` int AUTO_INCREMENT NOT NULL,
	`trade_id` int NOT NULL,
	`leg_id` int NOT NULL,
	`exchange_id` varchar(32) NOT NULL,
	`side` enum('long','short') NOT NULL,
	`mark_price_usd` decimal(24,8) NOT NULL,
	`entry_price_usd` decimal(24,8),
	`quantity_base` decimal(24,10),
	`unrealized_pnl_usd` decimal(24,8),
	`sampled_at` timestamp NOT NULL,
	CONSTRAINT `unhedged_leg_samples_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `unhedged_leg_samples` ADD CONSTRAINT `unhedged_leg_samples_trade_id_trades_id_fk` FOREIGN KEY (`trade_id`) REFERENCES `trades`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `unhedged_leg_samples` ADD CONSTRAINT `unhedged_leg_samples_leg_id_trade_legs_id_fk` FOREIGN KEY (`leg_id`) REFERENCES `trade_legs`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `unhedged_leg_samples_trade_sampled_idx` ON `unhedged_leg_samples` (`trade_id`,`sampled_at`);--> statement-breakpoint
CREATE INDEX `unhedged_leg_samples_leg_idx` ON `unhedged_leg_samples` (`leg_id`);