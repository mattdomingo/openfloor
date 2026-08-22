CREATE TABLE `session_mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`name` text NOT NULL,
	`transport` text NOT NULL,
	`url` text NOT NULL,
	`headers_ciphertext` text,
	`header_names` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_session_mcp_servers_session_name` ON `session_mcp_servers` (`session_id`,`name`);--> statement-breakpoint
CREATE TABLE `session_skills` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`content` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_session_skills_session_name` ON `session_skills` (`session_id`,`name`);--> statement-breakpoint
CREATE TABLE `user_provider_credentials` (
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`kind` text DEFAULT 'api_key' NOT NULL,
	`ciphertext` text NOT NULL,
	`fingerprint` text NOT NULL,
	`validated_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `provider`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `floor_agents` ADD `provider` text DEFAULT 'openai' NOT NULL;--> statement-breakpoint
ALTER TABLE `floor_agents` ADD `model` text;