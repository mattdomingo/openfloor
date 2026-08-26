CREATE TABLE `github_account_connection_states` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`purpose` text NOT NULL,
	`return_to` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "github_account_states_purpose_check" CHECK("github_account_connection_states"."purpose" in ('onboarding', 'settings'))
);
--> statement-breakpoint
CREATE INDEX `idx_github_account_states_user` ON `github_account_connection_states` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_github_account_states_expiry` ON `github_account_connection_states` (`expires_at`);--> statement-breakpoint
CREATE TABLE `user_github_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`account_login` text NOT NULL,
	`account_type` text NOT NULL,
	`status` text NOT NULL,
	`connected_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "user_github_installations_status_check" CHECK("user_github_installations"."status" in ('active', 'revoked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_user_github_installations_user_installation` ON `user_github_installations` (`user_id`,`installation_id`);--> statement-breakpoint
CREATE INDEX `idx_user_github_installations_user_status` ON `user_github_installations` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_user_github_installations_installation` ON `user_github_installations` (`installation_id`);--> statement-breakpoint
INSERT INTO `user_github_installations`
  (`id`, `user_id`, `installation_id`, `account_login`, `account_type`, `status`, `connected_at`, `updated_at`)
SELECT
  lower(hex(randomblob(16))),
  `connected_by`,
  `installation_id`,
  MIN(`repository_owner`),
  'Account',
  'active',
  MIN(`connected_at`),
  MAX(`updated_at`)
FROM `repository_connections`
WHERE `status` IN ('connected', 'ready', 'externally_modified')
GROUP BY `connected_by`, `installation_id`
ON CONFLICT (`user_id`, `installation_id`) DO NOTHING;
