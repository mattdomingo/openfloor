ALTER TABLE `agent_runs` ADD `kind` text;--> statement-breakpoint
ALTER TABLE `floor_agents` ADD `kind` text;--> statement-breakpoint
CREATE INDEX `idx_floor_agents_session_kind` ON `floor_agents` (`session_id`,`kind`);--> statement-breakpoint
ALTER TABLE `floor_queue_items` ADD `intent` text;