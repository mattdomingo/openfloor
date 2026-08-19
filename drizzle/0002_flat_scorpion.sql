CREATE TABLE `github_connection_states` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`user_id` text NOT NULL,
	`installation_id` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`configured_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_github_connection_states_session_user` ON `github_connection_states` (`session_id`,`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_github_connection_states_expiry` ON `github_connection_states` (`expires_at`);--> statement-breakpoint
CREATE TABLE `repository_check_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`position` integer NOT NULL,
	`command` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `repository_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_repository_check_commands_position` ON `repository_check_commands` (`connection_id`,`position`);--> statement-breakpoint
CREATE TABLE `repository_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`repository_node_id` text NOT NULL,
	`repository_owner` text NOT NULL,
	`repository_name` text NOT NULL,
	`repository_full_name` text NOT NULL,
	`repository_private` integer NOT NULL,
	`default_branch` text NOT NULL,
	`base_branch` text NOT NULL,
	`status` text NOT NULL,
	`connected_by` text NOT NULL,
	`connected_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`disconnected_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connected_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "repository_connections_status_check" CHECK("repository_connections"."status" in ('connected', 'disconnected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_repository_connections_one_per_session` ON `repository_connections` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_repository_connections_installation` ON `repository_connections` (`installation_id`);