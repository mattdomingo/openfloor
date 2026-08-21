-- Hand-fixed, same reason as 0018: drizzle-kit's natural output for a new
-- column backed by a named/table-level CHECK (the `check()` helper in
-- db/schema.ts) is a full `users` table recreate. `users` has inbound
-- ON DELETE CASCADE foreign keys (session_members.user_id,
-- session_invites.created_by, github_connection_states.user_id) — rehearsing
-- the generated recreate locally against seeded data confirmed it
-- cascade-deletes all three despite the `PRAGMA foreign_keys=OFF` wrapper.
-- A plain ADD COLUMN carries none of that risk.
ALTER TABLE `users` ADD `plan_status` text DEFAULT 'inactive' NOT NULL CHECK (`plan_status` in ('inactive', 'active', 'past_due', 'canceled'));
--> statement-breakpoint
-- Grandfather every user who exists as of this migration to 'active' (they
-- are all on a plan set manually pre-billing-integration today). Anyone who
-- signs up after this migration has already run gets the column default
-- above ('inactive') instead, since upsertUser's INSERT omits plan_status.
UPDATE `users` SET `plan_status` = 'active';
