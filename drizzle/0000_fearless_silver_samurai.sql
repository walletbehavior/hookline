CREATE TABLE `alert_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`alert_id` integer NOT NULL,
	`event_key` text NOT NULL,
	`delivered_at` integer NOT NULL,
	FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alert_deliveries_event_unique` ON `alert_deliveries` (`alert_id`,`event_key`);--> statement-breakpoint
CREATE INDEX `alert_deliveries_alert_idx` ON `alert_deliveries` (`alert_id`,`delivered_at`);--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`telegram_user_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`target_type` text DEFAULT 'hook' NOT NULL,
	`chain_id` integer NOT NULL,
	`target_address` text NOT NULL,
	`rule` text DEFAULT 'hook_activity' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`baseline_json` text,
	`next_check_at` integer NOT NULL,
	`last_checked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alerts_user_target_unique` ON `alerts` (`telegram_user_id`,`chat_id`,`chain_id`,`target_address`);--> statement-breakpoint
CREATE INDEX `alerts_due_idx` ON `alerts` (`enabled`,`next_check_at`);--> statement-breakpoint
CREATE INDEX `alerts_user_idx` ON `alerts` (`telegram_user_id`,`enabled`);