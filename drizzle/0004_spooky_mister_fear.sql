CREATE TABLE `repository_preflight_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`preflight_id` text NOT NULL,
	`position` integer NOT NULL,
	`command` text NOT NULL,
	`status` text NOT NULL,
	`exit_code` integer,
	`duration_ms` integer,
	`output_excerpt` text,
	`log_key` text,
	`started_at` integer,
	`completed_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`preflight_id`) REFERENCES `repository_preflights`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "repository_preflight_checks_status_check" CHECK("repository_preflight_checks"."status" in ('pending', 'running', 'passed', 'failed', 'timed_out'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_repository_preflight_checks_position` ON `repository_preflight_checks` (`preflight_id`,`position`);--> statement-breakpoint
CREATE TABLE `repository_preflights` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`candidate_id` text NOT NULL,
	`candidate_sha` text NOT NULL,
	`workflow_instance_id` text,
	`status` text NOT NULL,
	`summary` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `repository_connections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`candidate_id`) REFERENCES `repository_candidates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "repository_preflights_status_check" CHECK("repository_preflights"."status" in ('provisioning', 'running', 'passed', 'failed', 'cancelled', 'timed_out'))
);
--> statement-breakpoint
CREATE INDEX `idx_repository_preflights_session_created` ON `repository_preflights` (`session_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_repository_preflights_one_active` ON `repository_preflights` (`session_id`) WHERE "repository_preflights"."status" in ('provisioning', 'running');