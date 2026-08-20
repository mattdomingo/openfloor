CREATE TABLE `routing_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`queue_item_id` text,
	`agent_id` text,
	`run_id` text,
	`decision` text NOT NULL,
	`reason` text NOT NULL,
	`candidates` text DEFAULT '[]' NOT NULL,
	`triggered_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`queue_item_id`) REFERENCES `floor_queue_items`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`agent_id`) REFERENCES `floor_agents`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "routing_decisions_decision_check" CHECK("routing_decisions"."decision" in ('assigned', 'dispatched', 'held', 'skipped')),
	CONSTRAINT "routing_decisions_trigger_check" CHECK("routing_decisions"."triggered_by" in ('enqueue', 'run_completed', 'toggle', 'agent_changed', 'alarm'))
);
--> statement-breakpoint
CREATE INDEX `idx_routing_decisions_session_created` ON `routing_decisions` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_routing_decisions_item` ON `routing_decisions` (`queue_item_id`);--> statement-breakpoint
ALTER TABLE `floor_queue_items` ADD `assigned_by` text;--> statement-breakpoint
ALTER TABLE `floor_queue_items` ADD `assigned_reason` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `auto_dispatch` integer DEFAULT false NOT NULL;