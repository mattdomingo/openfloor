CREATE TABLE `usage_months` (
	`owner_user_id` text NOT NULL,
	`month` text NOT NULL,
	`seconds` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`owner_user_id`, `month`)
);
--> statement-breakpoint
ALTER TABLE `sessions` ADD `active_seconds` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `plan` text DEFAULT 'pro' NOT NULL CHECK (`plan` in ('pro', 'max', 'enterprise'));
