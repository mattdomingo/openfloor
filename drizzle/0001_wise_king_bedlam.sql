CREATE TABLE `floor_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`created_by` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`role` text NOT NULL,
	`task` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "floor_agents_state_check" CHECK("floor_agents"."state" in ('created'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_floor_agents_session_name` ON `floor_agents` (`session_id`,`name_key`);--> statement-breakpoint
CREATE INDEX `idx_floor_agents_session_created` ON `floor_agents` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_floor_agents_owner` ON `floor_agents` (`owner_user_id`);--> statement-breakpoint
CREATE TABLE `floor_assignments` (
	`session_id` text NOT NULL,
	`user_id` text NOT NULL,
	`task` text,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`session_id`, `user_id`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_floor_assignments_updated_by` ON `floor_assignments` (`updated_by`);--> statement-breakpoint
CREATE TABLE `floor_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`author_user_id` text NOT NULL,
	`recipient_user_id` text,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recipient_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_floor_messages_session_created` ON `floor_messages` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_floor_messages_recipient` ON `floor_messages` (`recipient_user_id`);--> statement-breakpoint
CREATE TABLE `floor_queue_items` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`agent_id` text,
	`position` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `floor_agents`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "floor_queue_status_check" CHECK("floor_queue_items"."status" in ('queued'))
);
--> statement-breakpoint
CREATE INDEX `idx_floor_queue_session_position` ON `floor_queue_items` (`session_id`,`position`);--> statement-breakpoint
CREATE INDEX `idx_floor_queue_agent` ON `floor_queue_items` (`agent_id`);--> statement-breakpoint
CREATE TABLE `floor_queue_prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`queue_item_id` text NOT NULL,
	`author_user_id` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`queue_item_id`) REFERENCES `floor_queue_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_floor_queue_prompts_item_created` ON `floor_queue_prompts` (`queue_item_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `floor_revision` integer DEFAULT 0 NOT NULL;