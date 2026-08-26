CREATE TABLE `agent_run_rollback_group_items` (
	`group_id` text NOT NULL,
	`rollback_id` text NOT NULL,
	PRIMARY KEY(`group_id`, `rollback_id`),
	FOREIGN KEY (`group_id`) REFERENCES `agent_run_rollback_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`rollback_id`) REFERENCES `agent_run_rollbacks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_run_rollback_group_items_rollback` ON `agent_run_rollback_group_items` (`rollback_id`);--> statement-breakpoint
CREATE TABLE `agent_run_rollback_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`candidate_id` text NOT NULL,
	`lease_run_id` text NOT NULL,
	`scope` text NOT NULL,
	`subject_id` text NOT NULL,
	`expected_candidate_sha` text NOT NULL,
	`rollback_commit_sha` text,
	`status` text NOT NULL,
	`failure_reason` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`candidate_id`) REFERENCES `repository_candidates`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lease_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_run_rollback_groups_scope_check" CHECK("agent_run_rollback_groups"."scope" in ('prompt', 'engineer', 'agent')),
	CONSTRAINT "agent_run_rollback_groups_status_check" CHECK("agent_run_rollback_groups"."status" in ('requested', 'running', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `idx_agent_run_rollback_groups_session_created` ON `agent_run_rollback_groups` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_run_rollback_groups_candidate_status` ON `agent_run_rollback_groups` (`candidate_id`,`status`);