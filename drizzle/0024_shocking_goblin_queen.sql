CREATE TABLE `stripe_customers` (
	`user_id` text PRIMARY KEY NOT NULL,
	`stripe_customer_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_stripe_customers_customer` ON `stripe_customers` (`stripe_customer_id`);--> statement-breakpoint
CREATE TABLE `stripe_subscriptions` (
	`stripe_subscription_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`stripe_customer_id` text NOT NULL,
	`stripe_price_id` text NOT NULL,
	`plan` text,
	`quantity` integer NOT NULL,
	`status` text NOT NULL,
	`current_period_end` integer,
	`cancel_at_period_end` integer DEFAULT false NOT NULL,
	`event_created` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_stripe_subscriptions_user` ON `stripe_subscriptions` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_stripe_subscriptions_customer` ON `stripe_subscriptions` (`stripe_customer_id`);--> statement-breakpoint
CREATE TABLE `stripe_webhook_events` (
	`stripe_event_id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`processing_status` text NOT NULL,
	`error` text,
	`received_at` integer NOT NULL,
	`processed_at` integer
);
--> statement-breakpoint
ALTER TABLE `users` ADD `seat_limit` integer;