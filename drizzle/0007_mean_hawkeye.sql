ALTER TABLE `agent_runs` ADD `integration_base_sha` text;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `integrated_candidate_sha` text;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `conflict_reason` text;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `integration_started_at` integer;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `integrated_at` integer;--> statement-breakpoint
ALTER TABLE `repository_candidates` ADD `integration_run_id` text;--> statement-breakpoint
ALTER TABLE `repository_candidates` ADD `pull_request_number` integer;--> statement-breakpoint
ALTER TABLE `repository_candidates` ADD `pull_request_node_id` text;--> statement-breakpoint
ALTER TABLE `repository_candidates` ADD `pull_request_url` text;--> statement-breakpoint
ALTER TABLE `repository_candidates` ADD `pull_request_state` text;--> statement-breakpoint
ALTER TABLE `repository_candidates` ADD `pull_request_draft` integer;