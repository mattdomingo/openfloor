CREATE TABLE `merge_conflict_selections` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`snapshot_run_id` text NOT NULL,
	`path` text NOT NULL,
	`hunk_index` integer NOT NULL,
	`choice` text NOT NULL,
	`selected_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `merge_conflict_cases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`snapshot_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`selected_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_merge_conflict_selections_snapshot_hunk` ON `merge_conflict_selections` (`snapshot_run_id`,`path`,`hunk_index`);--> statement-breakpoint
CREATE INDEX `idx_merge_conflict_selections_case` ON `merge_conflict_selections` (`case_id`,`created_at`);