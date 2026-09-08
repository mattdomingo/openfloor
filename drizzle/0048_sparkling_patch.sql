CREATE TABLE `merge_conflict_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `merge_conflict_cases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`snapshot_id`) REFERENCES `merge_conflict_snapshots`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_conflict_proposals_case` ON `merge_conflict_proposals` (`case_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `merge_conflict_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`run_id` text NOT NULL,
	`source_run_id` text NOT NULL,
	`candidate_sha` text NOT NULL,
	`source_commit_sha` text NOT NULL,
	`manifest_key` text NOT NULL,
	`provenance` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `merge_conflict_cases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_conflict_snapshots_run` ON `merge_conflict_snapshots` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_conflict_snapshots_case` ON `merge_conflict_snapshots` (`case_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `merge_conflict_votes` (
	`id` text PRIMARY KEY NOT NULL,
	`proposal_id` text NOT NULL,
	`user_id` text,
	`action` text NOT NULL,
	`reason` text,
	`case_revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`proposal_id`) REFERENCES `merge_conflict_proposals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_conflict_votes_proposal` ON `merge_conflict_votes` (`proposal_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `merge_conflict_attempts` ADD `execution_mode` text DEFAULT 'ai' NOT NULL;--> statement-breakpoint
ALTER TABLE `merge_conflict_attempts` ADD `snapshot_id` text;--> statement-breakpoint
ALTER TABLE `merge_conflict_attempts` ADD `proposal_id` text;--> statement-breakpoint
ALTER TABLE `merge_conflict_attempts` ADD `source_run_id` text;--> statement-breakpoint
ALTER TABLE `merge_conflict_attempts` ADD `assessment` text;--> statement-breakpoint
ALTER TABLE `merge_conflict_cases` ADD `revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `merge_conflict_cases` ADD `trigger` text DEFAULT 'git' NOT NULL;--> statement-breakpoint
ALTER TABLE `merge_conflict_cases` ADD `mode` text DEFAULT 'prepare' NOT NULL;--> statement-breakpoint
ALTER TABLE `merge_conflict_cases` ADD `snapshot_id` text;--> statement-breakpoint
ALTER TABLE `merge_conflict_cases` ADD `proposal_id` text;--> statement-breakpoint
ALTER TABLE `merge_conflict_cases` ADD `waiting_reason` text;