CREATE TABLE `session_files` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`uploaded_by_user_id` text NOT NULL,
	`message_id` text,
	`name` text NOT NULL,
	`r2_key` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploaded_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `floor_messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_session_files_session_created` ON `session_files` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_session_files_message` ON `session_files` (`message_id`);