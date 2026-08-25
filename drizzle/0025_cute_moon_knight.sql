CREATE TABLE `merge_conflict_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`run_id` text NOT NULL,
	`launch_kind` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `merge_conflict_cases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "merge_conflict_attempts_launch_check" CHECK("merge_conflict_attempts"."launch_kind" in ('automatic', 'manual', 'answer'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_merge_conflict_attempts_run` ON `merge_conflict_attempts` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_merge_conflict_attempts_case` ON `merge_conflict_attempts` (`case_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `merge_conflict_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`source_run_id` text NOT NULL,
	`latest_source_run_id` text NOT NULL,
	`current_resolver_run_id` text,
	`status` text NOT NULL,
	`explanation` text,
	`conflict_paths` text DEFAULT '[]' NOT NULL,
	`automatic_attempts` integer DEFAULT 0 NOT NULL,
	`resume_requested` integer DEFAULT false NOT NULL,
	`failure_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`latest_source_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`current_resolver_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "merge_conflict_cases_status_check" CHECK("merge_conflict_cases"."status" in ('pending', 'resolving', 'awaiting_input', 'resolved', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_merge_conflict_cases_source_run` ON `merge_conflict_cases` (`source_run_id`);--> statement-breakpoint
CREATE INDEX `idx_merge_conflict_cases_session_status` ON `merge_conflict_cases` (`session_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `merge_conflict_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`requested_by_run_id` text NOT NULL,
	`position` integer NOT NULL,
	`question` text NOT NULL,
	`answer` text,
	`answered_by` text,
	`requested_at` integer NOT NULL,
	`answered_at` integer,
	FOREIGN KEY (`case_id`) REFERENCES `merge_conflict_cases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requested_by_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`answered_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_merge_conflict_questions_run_position` ON `merge_conflict_questions` (`requested_by_run_id`,`position`);--> statement-breakpoint
CREATE INDEX `idx_merge_conflict_questions_case` ON `merge_conflict_questions` (`case_id`,`requested_at`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `auto_resolve_conflicts` integer DEFAULT true NOT NULL;
