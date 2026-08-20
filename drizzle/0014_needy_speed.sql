CREATE TABLE `sandbox_pool` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`state` text NOT NULL,
	`claimed_by_run_id` text,
	`last_used_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sandbox_pool_repository_state` ON `sandbox_pool` (`repository_id`,`state`,`last_used_at`);