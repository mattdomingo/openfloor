-- Two plain ADD COLUMN statements, verified rather than assumed safe: unlike
-- 0018/0019's users.plan/plan_status, neither new column is itself
-- CHECK-constrained, so drizzle-kit did not need the full-table-recreate
-- path here even though session_members already carries a named CHECK on
-- `role`. No hand-fix required.
ALTER TABLE `session_members` ADD `removed_at` integer;--> statement-breakpoint
ALTER TABLE `session_members` ADD `removed_by` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `locked_at` integer;