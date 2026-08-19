CREATE TABLE `github_webhook_deliveries` (
	`delivery_id` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`action` text,
	`installation_id` text,
	`repository_id` text,
	`received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_github_webhook_deliveries_received` ON `github_webhook_deliveries` (`received_at`);--> statement-breakpoint
CREATE TABLE `repository_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`branch_name` text NOT NULL,
	`base_branch` text NOT NULL,
	`base_sha` text NOT NULL,
	`candidate_sha` text,
	`remote_base_sha` text,
	`remote_candidate_sha` text,
	`status` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_synced_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `repository_connections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "repository_candidates_status_check" CHECK("repository_candidates"."status" in ('creating', 'active', 'creation_failed'))
);
--> statement-breakpoint
CREATE INDEX `idx_repository_candidates_session_created` ON `repository_candidates` (`session_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_repository_candidates_one_live` ON `repository_candidates` (`session_id`) WHERE "repository_candidates"."status" in ('creating', 'active');--> statement-breakpoint
CREATE UNIQUE INDEX `idx_repository_candidates_branch` ON `repository_candidates` (`connection_id`,`branch_name`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_repository_connections` (
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
	CONSTRAINT "repository_connections_status_check" CHECK("__new_repository_connections"."status" in ('connected', 'ready', 'revoked', 'inaccessible', 'externally_modified', 'disconnected'))
);
--> statement-breakpoint
INSERT INTO `__new_repository_connections`("id", "session_id", "installation_id", "repository_id", "repository_node_id", "repository_owner", "repository_name", "repository_full_name", "repository_private", "default_branch", "base_branch", "status", "connected_by", "connected_at", "updated_at", "disconnected_at") SELECT "id", "session_id", "installation_id", "repository_id", "repository_node_id", "repository_owner", "repository_name", "repository_full_name", "repository_private", "default_branch", "base_branch", "status", "connected_by", "connected_at", "updated_at", "disconnected_at" FROM `repository_connections`;--> statement-breakpoint
DROP TABLE `repository_connections`;--> statement-breakpoint
ALTER TABLE `__new_repository_connections` RENAME TO `repository_connections`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_repository_connections_one_per_session` ON `repository_connections` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_repository_connections_installation` ON `repository_connections` (`installation_id`);