CREATE TABLE `candidate_file_removals` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`candidate_id` text NOT NULL,
	`path` text NOT NULL,
	`previous_path` text,
	`expected_candidate_sha` text NOT NULL,
	`base_sha` text NOT NULL,
	`removal_commit_sha` text,
	`status` text NOT NULL,
	`failure_reason` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`candidate_id`) REFERENCES `repository_candidates`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "candidate_file_removals_status_check" CHECK("candidate_file_removals"."status" in ('requested', 'running', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `idx_candidate_file_removals_session_created` ON `candidate_file_removals` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_candidate_file_removals_candidate_path` ON `candidate_file_removals` (`candidate_id`,`path`,`created_at`);--> statement-breakpoint
ALTER TABLE `repository_candidate_files` ADD `previous_path` text;