CREATE TABLE `execution_intents` (
	`intent_id` text PRIMARY KEY NOT NULL,
	`chain_id` integer NOT NULL,
	`taker_address` text NOT NULL,
	`transaction_to` text NOT NULL,
	`transaction_data_hash` text NOT NULL,
	`transaction_value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`fee_token` text NOT NULL,
	`gross_fee_amount` text NOT NULL,
	`cashback_amount` text NOT NULL,
	`effective_fee_amount` text NOT NULL,
	`gross_fee_bps` integer DEFAULT 100 NOT NULL,
	`cashback_bps` integer DEFAULT 30 NOT NULL,
	`effective_fee_bps` integer DEFAULT 70 NOT NULL,
	`created_at` integer NOT NULL,
	`consumed_at` integer,
	`transaction_hash` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `execution_intents_transaction_unique` ON `execution_intents` (`transaction_hash`);--> statement-breakpoint
CREATE INDEX `execution_intents_expiry_idx` ON `execution_intents` (`expires_at`,`consumed_at`);--> statement-breakpoint
CREATE INDEX `execution_intents_wallet_idx` ON `execution_intents` (`taker_address`,`created_at`);--> statement-breakpoint
CREATE TABLE `execution_receipts` (
	`transaction_hash` text PRIMARY KEY NOT NULL,
	`intent_id` text NOT NULL,
	`chain_id` integer NOT NULL,
	`taker_address` text NOT NULL,
	`block_number` text NOT NULL,
	`fee_token` text NOT NULL,
	`gross_fee_amount` text NOT NULL,
	`cashback_amount` text NOT NULL,
	`effective_fee_amount` text NOT NULL,
	`confirmed_at` integer NOT NULL,
	FOREIGN KEY (`intent_id`) REFERENCES `execution_intents`(`intent_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `execution_receipts_intent_unique` ON `execution_receipts` (`intent_id`);--> statement-breakpoint
CREATE INDEX `execution_receipts_wallet_idx` ON `execution_receipts` (`taker_address`,`confirmed_at`);
