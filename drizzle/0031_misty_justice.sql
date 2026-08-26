CREATE TABLE `agent_run_rollbacks` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`session_id` text NOT NULL,
	`candidate_id` text NOT NULL,
	`expected_candidate_sha` text NOT NULL,
	`rollback_commit_sha` text,
	`status` text NOT NULL,
	`failure_reason` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`candidate_id`) REFERENCES `repository_candidates`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_run_rollbacks_status_check" CHECK("agent_run_rollbacks"."status" in ('requested', 'running', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `idx_agent_run_rollbacks_session_created` ON `agent_run_rollbacks` (`session_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_run_rollbacks_one_active` ON `agent_run_rollbacks` (`run_id`) WHERE "agent_run_rollbacks"."status" in ('requested', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_run_rollbacks_one_completed` ON `agent_run_rollbacks` (`run_id`) WHERE "agent_run_rollbacks"."status" = 'completed';