CREATE TABLE `repository_previews` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`candidate_id` text NOT NULL,
	`generation` integer DEFAULT 1 NOT NULL,
	`status` text NOT NULL,
	`target_candidate_sha` text NOT NULL,
	`active_candidate_sha` text,
	`workflow_instance_id` text,
	`pending_sandbox_id` text,
	`active_sandbox_id` text,
	`active_url` text,
	`active_host` text,
	`detected_package_manager` text,
	`detected_script` text,
	`failure_reason` text,
	`started_by` text NOT NULL,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`candidate_id`) REFERENCES `repository_candidates`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`started_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "repository_previews_status_check" CHECK("repository_previews"."status" in ('stopped', 'provisioning', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_repository_previews_session` ON `repository_previews` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_repository_previews_active_host` ON `repository_previews` (`active_host`);--> statement-breakpoint
CREATE INDEX `idx_repository_previews_capacity` ON `repository_previews` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `sandbox_cleanup_intents` (
	`sandbox_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`not_before` integer NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sandbox_cleanup_due` ON `sandbox_cleanup_intents` (`not_before`);