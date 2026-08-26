DROP INDEX `idx_repository_candidates_one_live`;--> statement-breakpoint
ALTER TABLE `repository_candidates` ADD `abandoned_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_repository_candidates_one_live` ON `repository_candidates` (`session_id`) WHERE "repository_candidates"."status" in ('creating', 'active') and "repository_candidates"."merged_at" is null and "repository_candidates"."abandoned_at" is null;--> statement-breakpoint
ALTER TABLE `users` ADD `prior_email_hash` text;--> statement-breakpoint
ALTER TABLE `users` ADD `free_allowance_used_at` integer;--> statement-breakpoint
CREATE INDEX `idx_users_prior_email_hash` ON `users` (`prior_email_hash`);