CREATE TABLE `early_access_waitlist` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'waiting' NOT NULL,
	`consent_version` text NOT NULL,
	`consented_at` integer NOT NULL,
	`sheet_sync_state` text DEFAULT 'pending' NOT NULL,
	`sheet_sync_attempts` integer DEFAULT 0 NOT NULL,
	`sheet_next_attempt_at` integer NOT NULL,
	`sheet_last_error` text,
	`sheet_synced_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_early_access_waitlist_email` ON `early_access_waitlist` (`email`);--> statement-breakpoint
CREATE INDEX `idx_early_access_waitlist_sheet_sync` ON `early_access_waitlist` (`sheet_sync_state`,`sheet_next_attempt_at`);--> statement-breakpoint
CREATE INDEX `idx_early_access_waitlist_updated_at` ON `early_access_waitlist` (`updated_at`);--> statement-breakpoint
ALTER TABLE `users` ADD `early_access_granted_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `early_access_revoked_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `early_access_grant_source` text;--> statement-breakpoint
UPDATE `users`
SET `early_access_granted_at` = `created_at`,
    `early_access_grant_source` = 'existing'
WHERE `deleted_at` IS NULL;
