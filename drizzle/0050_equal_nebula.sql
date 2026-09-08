ALTER TABLE `floor_agents` ADD `usage_scope` text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE `session_members` ADD `auto_agents_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `default_api_provider` text;