ALTER TABLE `agent_runs` ADD `resumed_from_run_id` text;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `provider_thread_resumed` integer;--> statement-breakpoint
ALTER TABLE `floor_queue_items` ADD `source_run_id` text;