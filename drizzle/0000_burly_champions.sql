CREATE TABLE `session_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_session_invites_session_id` ON `session_invites` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_session_invites_one_active` ON `session_invites` (`session_id`) WHERE "session_invites"."revoked_at" is null;--> statement-breakpoint
CREATE TABLE `session_members` (
	`session_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`joined_at` integer NOT NULL,
	PRIMARY KEY(`session_id`, `user_id`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "session_members_role_check" CHECK("session_members"."role" in ('owner', 'member'))
);
--> statement-breakpoint
CREATE INDEX `idx_session_members_user_id` ON `session_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`objective` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`chatgpt_user_id` text NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_chatgpt_user_id` ON `users` (`chatgpt_user_id`);