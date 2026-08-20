PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_floor_queue_items` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`agent_id` text,
	`position` integer NOT NULL,
	`status` text NOT NULL,
	`assigned_by` text,
	`assigned_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `floor_agents`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "floor_queue_status_check" CHECK("__new_floor_queue_items"."status" in ('queued', 'running', 'blocked', 'completed', 'paused', 'failed', 'cancelled'))
);
--> statement-breakpoint
INSERT INTO `__new_floor_queue_items`("id", "session_id", "agent_id", "position", "status", "assigned_by", "assigned_reason", "created_at", "updated_at") SELECT "id", "session_id", "agent_id", "position", "status", "assigned_by", "assigned_reason", "created_at", "updated_at" FROM `floor_queue_items`;--> statement-breakpoint
DROP TABLE `floor_queue_items`;--> statement-breakpoint
ALTER TABLE `__new_floor_queue_items` RENAME TO `floor_queue_items`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_floor_queue_session_position` ON `floor_queue_items` (`session_id`,`position`);--> statement-breakpoint
CREATE INDEX `idx_floor_queue_agent` ON `floor_queue_items` (`agent_id`);