CREATE TABLE `agent_run_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`r2_key` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_run_artifacts_kind` ON `agent_run_artifacts` (`run_id`,`kind`);--> statement-breakpoint
CREATE TABLE `agent_run_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
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
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_run_checks_status_check" CHECK("agent_run_checks"."status" in ('pending', 'running', 'passed', 'failed', 'timed_out'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_run_checks_position` ON `agent_run_checks` (`run_id`,`position`);--> statement-breakpoint
CREATE TABLE `agent_run_events` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`kind` text NOT NULL,
	`detail` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_run_events_sequence` ON `agent_run_events` (`run_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `agent_run_files` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`path` text NOT NULL,
	`change_kind` text NOT NULL,
	`additions` integer NOT NULL,
	`deletions` integer NOT NULL,
	`summary` text,
	`diff_preview` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_run_files_path` ON `agent_run_files` (`run_id`,`path`);--> statement-breakpoint
CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`queue_item_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`candidate_id` text NOT NULL,
	`candidate_sha` text NOT NULL,
	`attempt` integer NOT NULL,
	`status` text NOT NULL,
	`model` text NOT NULL,
	`workflow_instance_id` text,
	`sandbox_id` text NOT NULL,
	`sandbox_process_id` text,
	`codex_thread_id` text,
	`summary` text,
	`final_response` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`cancel_requested_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`queue_item_id`) REFERENCES `floor_queue_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `floor_agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`candidate_id`) REFERENCES `repository_candidates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_runs_status_check" CHECK("agent_runs"."status" in ('provisioning', 'running', 'checking', 'ready', 'publishing', 'published', 'integrating', 'integrated', 'conflicted', 'failed', 'cancel_requested', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `idx_agent_runs_session_created` ON `agent_runs` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_runs_agent_created` ON `agent_runs` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_runs_queue_attempt` ON `agent_runs` (`queue_item_id`,`attempt`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_runs_one_active_per_item` ON `agent_runs` (`queue_item_id`) WHERE "agent_runs"."status" in ('provisioning', 'running', 'checking', 'cancel_requested');--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_floor_queue_items` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`agent_id` text,
	`position` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `floor_agents`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "floor_queue_status_check" CHECK("__new_floor_queue_items"."status" in ('queued', 'running', 'blocked', 'completed'))
);
--> statement-breakpoint
INSERT INTO `__new_floor_queue_items`("id", "session_id", "agent_id", "position", "status", "created_at", "updated_at") SELECT "id", "session_id", "agent_id", "position", "status", "created_at", "updated_at" FROM `floor_queue_items`;--> statement-breakpoint
DROP TABLE `floor_queue_items`;--> statement-breakpoint
ALTER TABLE `__new_floor_queue_items` RENAME TO `floor_queue_items`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_floor_queue_session_position` ON `floor_queue_items` (`session_id`,`position`);--> statement-breakpoint
CREATE INDEX `idx_floor_queue_agent` ON `floor_queue_items` (`agent_id`);