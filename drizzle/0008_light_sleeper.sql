CREATE TABLE `repository_candidate_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`candidate_id` text NOT NULL,
	`source_id` text NOT NULL,
	`name` text NOT NULL,
	`detail` text,
	`state` text NOT NULL,
	FOREIGN KEY (`candidate_id`) REFERENCES `repository_candidates`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_repository_candidate_checks_source` ON `repository_candidate_checks` (`candidate_id`,`source_id`);--> statement-breakpoint
CREATE TABLE `repository_candidate_files` (
	`id` text PRIMARY KEY NOT NULL,
	`candidate_id` text NOT NULL,
	`path` text NOT NULL,
	`additions` integer NOT NULL,
	`deletions` integer NOT NULL,
	`change_kind` text NOT NULL,
	`patch_preview` text NOT NULL,
	FOREIGN KEY (`candidate_id`) REFERENCES `repository_candidates`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_repository_candidate_files_path` ON `repository_candidate_files` (`candidate_id`,`path`);--> statement-breakpoint
DROP INDEX `idx_repository_candidates_one_live`;--> statement-breakpoint
ALTER TABLE `repository_candidates` ADD `pull_request_merged` integer;--> statement-breakpoint
ALTER TABLE `repository_candidates` ADD `pull_request_mergeable` integer;--> statement-breakpoint
ALTER TABLE `repository_candidates` ADD `pull_request_mergeable_state` text;--> statement-breakpoint
ALTER TABLE `repository_candidates` ADD `github_checks_passing` integer;--> statement-breakpoint
ALTER TABLE `repository_candidates` ADD `review_ready_at` integer;--> statement-breakpoint
ALTER TABLE `repository_candidates` ADD `review_ready_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `repository_candidates` ADD `review_synced_at` integer;--> statement-breakpoint
ALTER TABLE `repository_candidates` ADD `merge_commit_sha` text;--> statement-breakpoint
ALTER TABLE `repository_candidates` ADD `merged_at` integer;--> statement-breakpoint
ALTER TABLE `repository_candidates` ADD `merged_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `repository_candidates` ADD `cleanup_status` text;--> statement-breakpoint
ALTER TABLE `repository_candidates` ADD `cleanup_completed_at` integer;--> statement-breakpoint
ALTER TABLE `repository_candidates` ADD `branch_deleted_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_repository_candidates_one_live` ON `repository_candidates` (`session_id`) WHERE "repository_candidates"."status" in ('creating', 'active') and "repository_candidates"."merged_at" is null;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `branch_deleted_at` integer;