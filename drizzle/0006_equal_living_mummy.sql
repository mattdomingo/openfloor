ALTER TABLE `agent_runs` ADD `run_branch` text;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `bundle_key` text;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `bundle_size_bytes` integer;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `local_commit_sha` text;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `run_commit_sha` text;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `remote_run_sha` text;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `published_at` integer;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `discarded_at` integer;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `discarded_by` text REFERENCES users(id);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_runs_branch` ON `agent_runs` (`candidate_id`,`run_branch`);