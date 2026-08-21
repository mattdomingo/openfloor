-- Hand-written, not drizzle-kit output: this is a one-time data repair, not a
-- schema change drizzle-kit knows how to express. Root cause: Cloudflare
-- Access issues a different `sub` per identity provider (Google vs. a
-- one-time email code) and, until now, email comparison in upsertUser
-- (db/sessions.ts) was case-sensitive and unindexed, so a user who signed in
-- with different casing or a different provider than their first login
-- landed on a brand-new, membership-less account. That is the direct cause
-- of the "Google sign-in returns 404" bug this migration fixes.
--
-- This migration is idempotent: a second run finds no email with more than
-- one surviving row and the CREATE UNIQUE INDEX is a no-op via IF NOT EXISTS.
--> statement-breakpoint

-- Step 1: canonicalize. Every later step keys off this, including the
-- unique index at the end.
UPDATE `users` SET `email` = lower(trim(`email`));
--> statement-breakpoint

-- Step 2: for every email, rank its accounts and pick one survivor. Priority:
-- already onboarded (an un-onboarded duplicate is definitionally the newer,
-- emptier account) > holds more session memberships > older account > lower
-- id as a last, deterministic tiebreak. Singleton emails get a trivial
-- self-mapping (survivor_id = id), which makes every later step a no-op for
-- users who were never duplicated — no special-casing needed anywhere below.
--
-- These are real tables (dropped explicitly at the end of this file), not
-- per-statement CTEs, because the session_members/floor_assignments/
-- usage_months reconciliation below must read their pre-merge rows *after*
-- ranking has already been computed but *before* those rows are deleted and
-- reinserted under the survivor's id — a single statement cannot do both.
-- vitest-pool-workers' applyD1Migrations runs every statement in one file as
-- a single db.batch(), i.e. one transaction on one connection (mirroring how
-- 0019's PRAGMA foreign_keys=OFF persists across the statements after it in
-- that file), so these tables stay visible for the rest of this file.
CREATE TABLE `_account_rank` AS
SELECT
  `u`.`id` AS `id`,
  `u`.`email` AS `email`,
  `u`.`first_name` AS `first_name`,
  `u`.`last_name` AS `last_name`,
  `u`.`github_handle` AS `github_handle`,
  `u`.`avatar_key` AS `avatar_key`,
  `u`.`plan` AS `plan`,
  `u`.`plan_status` AS `plan_status`,
  CASE
    WHEN `u`.`plan_status` = 'active' AND `u`.`plan` = 'enterprise' THEN 12
    WHEN `u`.`plan_status` = 'active' AND `u`.`plan` = 'max' THEN 11
    WHEN `u`.`plan_status` = 'active' AND `u`.`plan` = 'pro' THEN 10
    WHEN `u`.`plan_status` = 'past_due' THEN 1
    ELSE 0
  END AS `plan_strength`,
  ROW_NUMBER() OVER (
    PARTITION BY `u`.`email`
    ORDER BY
      (`u`.`onboarded_at` IS NOT NULL) DESC,
      (SELECT COUNT(*) FROM `session_members` `sm` WHERE `sm`.`user_id` = `u`.`id` AND `sm`.`removed_at` IS NULL) DESC,
      `u`.`created_at` ASC,
      `u`.`id` ASC
  ) AS `rnk`
FROM `users` `u`;
--> statement-breakpoint

CREATE TABLE `_account_survivor` AS
SELECT `email`, `id` AS `survivor_id` FROM `_account_rank` WHERE `rnk` = 1;
--> statement-breakpoint

-- Every loser id in the file below is only ever looked up through this map,
-- so an email with a single account produces zero rows here and every
-- later statement that drives off it is a correct no-op.
CREATE TABLE `_account_merge_map` AS
SELECT `u`.`id` AS `loser_id`, `s`.`survivor_id` AS `survivor_id`
FROM `users` `u`
JOIN `_account_survivor` `s` ON `s`.`email` = `u`.`email`
WHERE `u`.`id` != `s`.`survivor_id`;
--> statement-breakpoint

-- Step 3a: session_members' primary key is (session_id, user_id), so a
-- survivor and its loser can each already hold a row for the same session.
-- Recompute the whole table from scratch, keyed by survivor id: for each
-- (survivor, session) pair, keep exactly one row. removed_at IS NULL wins
-- first — an active membership under one duplicate must not be shadowed by
-- a removed row from the other — then 'owner' over 'member' (owner rows are
-- never removed; removeMember refuses an owner target), then the earliest
-- join. Never silently demote someone from owner because their duplicate
-- account joined that session as a member.
CREATE TABLE `_session_members_final` AS
SELECT `session_id`, `survivor_id`, `role`, `joined_at`, `archived_at`, `removed_at`, `removed_by`
FROM (
  SELECT
    `sm`.`session_id` AS `session_id`,
    `sm`.`role` AS `role`,
    `sm`.`joined_at` AS `joined_at`,
    `sm`.`archived_at` AS `archived_at`,
    `sm`.`removed_at` AS `removed_at`,
    `sm`.`removed_by` AS `removed_by`,
    `s`.`survivor_id` AS `survivor_id`,
    ROW_NUMBER() OVER (
      PARTITION BY `s`.`survivor_id`, `sm`.`session_id`
      ORDER BY (`sm`.`removed_at` IS NULL) DESC, (`sm`.`role` = 'owner') DESC, `sm`.`joined_at` ASC
    ) AS `rnk`
  FROM `session_members` `sm`
  JOIN `users` `u` ON `u`.`id` = `sm`.`user_id`
  JOIN `_account_survivor` `s` ON `s`.`email` = `u`.`email`
) `ranked`
WHERE `rnk` = 1;
--> statement-breakpoint

DELETE FROM `session_members`;
--> statement-breakpoint

INSERT INTO `session_members` (`session_id`, `user_id`, `role`, `joined_at`, `archived_at`, `removed_at`, `removed_by`)
SELECT `session_id`, `survivor_id`, `role`, `joined_at`, `archived_at`, `removed_at`, `removed_by` FROM `_session_members_final`;
--> statement-breakpoint

-- session_members.removed_by is a second, independent reference to users
-- (who removed this member, not who it's about) and can still point at a
-- loser even after the reconciliation above — e.g. a removal performed by
-- an owner account that has since been merged away. No FK on this column
-- (see db/schema.ts), but a merge must still keep the audit trail pointing
-- at a real, current account. Simple repoint.
UPDATE `session_members`
SET `removed_by` = (SELECT `survivor_id` FROM `_account_merge_map` WHERE `loser_id` = `session_members`.`removed_by`)
WHERE `removed_by` IN (SELECT `loser_id` FROM `_account_merge_map`);
--> statement-breakpoint

-- Step 3b: floor_assignments is the same (session_id, user_id) shape.
-- Assignments don't merge meaningfully — they both describe "what this
-- person is doing right now" for the same session — so the more recently
-- updated one wins and the other is discarded as redundant.
CREATE TABLE `_floor_assignments_final` AS
SELECT `session_id`, `survivor_id`, `task`, `updated_by`, `updated_at`
FROM (
  SELECT
    `fa`.`session_id` AS `session_id`,
    `fa`.`task` AS `task`,
    `fa`.`updated_by` AS `updated_by`,
    `fa`.`updated_at` AS `updated_at`,
    `s`.`survivor_id` AS `survivor_id`,
    ROW_NUMBER() OVER (
      PARTITION BY `s`.`survivor_id`, `fa`.`session_id`
      ORDER BY `fa`.`updated_at` DESC
    ) AS `rnk`
  FROM `floor_assignments` `fa`
  JOIN `users` `u` ON `u`.`id` = `fa`.`user_id`
  JOIN `_account_survivor` `s` ON `s`.`email` = `u`.`email`
) `ranked`
WHERE `rnk` = 1;
--> statement-breakpoint

DELETE FROM `floor_assignments`;
--> statement-breakpoint

INSERT INTO `floor_assignments` (`session_id`, `user_id`, `task`, `updated_by`, `updated_at`)
SELECT `session_id`, `survivor_id`, `task`, `updated_by`, `updated_at` FROM `_floor_assignments_final`;
--> statement-breakpoint

-- floor_assignments.updated_by is a second, independent reference to users
-- (who last touched the assignment, not who it's for) and can still point at
-- a loser even after the reconciliation above. Simple repoint.
UPDATE `floor_assignments`
SET `updated_by` = (SELECT `survivor_id` FROM `_account_merge_map` WHERE `loser_id` = `floor_assignments`.`updated_by`)
WHERE `updated_by` IN (SELECT `loser_id` FROM `_account_merge_map`);
--> statement-breakpoint

-- Step 3c: usage_months' primary key is (owner_user_id, month) and it
-- deliberately carries no foreign key (it must survive session/user churn —
-- see its comment in db/schema.ts), but it is still keyed by a user id a
-- merge must repoint. Unlike the two tables above, a collision here is real
-- usage by the same person under two accounts and must not be lost: sum the
-- seconds rather than picking one side.
CREATE TABLE `_usage_months_final` AS
SELECT `s`.`survivor_id` AS `owner_user_id`, `um`.`month` AS `month`, SUM(`um`.`seconds`) AS `seconds`
FROM `usage_months` `um`
JOIN `users` `u` ON `u`.`id` = `um`.`owner_user_id`
JOIN `_account_survivor` `s` ON `s`.`email` = `u`.`email`
GROUP BY `s`.`survivor_id`, `um`.`month`;
--> statement-breakpoint

DELETE FROM `usage_months`;
--> statement-breakpoint

INSERT INTO `usage_months` (`owner_user_id`, `month`, `seconds`)
SELECT `owner_user_id`, `month`, `seconds` FROM `_usage_months_final`;
--> statement-breakpoint

-- Step 4: every other column referencing users.id is not part of a
-- composite key with another user column, so a plain repoint is safe — no
-- row can collide with another on this column alone.
UPDATE `session_invites`
SET `created_by` = (SELECT `survivor_id` FROM `_account_merge_map` WHERE `loser_id` = `session_invites`.`created_by`)
WHERE `created_by` IN (SELECT `loser_id` FROM `_account_merge_map`);
--> statement-breakpoint

UPDATE `floor_agents`
SET `created_by` = (SELECT `survivor_id` FROM `_account_merge_map` WHERE `loser_id` = `floor_agents`.`created_by`)
WHERE `created_by` IN (SELECT `loser_id` FROM `_account_merge_map`);
--> statement-breakpoint

UPDATE `floor_agents`
SET `owner_user_id` = (SELECT `survivor_id` FROM `_account_merge_map` WHERE `loser_id` = `floor_agents`.`owner_user_id`)
WHERE `owner_user_id` IN (SELECT `loser_id` FROM `_account_merge_map`);
--> statement-breakpoint

UPDATE `floor_messages`
SET `author_user_id` = (SELECT `survivor_id` FROM `_account_merge_map` WHERE `loser_id` = `floor_messages`.`author_user_id`)
WHERE `author_user_id` IN (SELECT `loser_id` FROM `_account_merge_map`);
--> statement-breakpoint

UPDATE `floor_messages`
SET `recipient_user_id` = (SELECT `survivor_id` FROM `_account_merge_map` WHERE `loser_id` = `floor_messages`.`recipient_user_id`)
WHERE `recipient_user_id` IN (SELECT `loser_id` FROM `_account_merge_map`);
--> statement-breakpoint

UPDATE `floor_queue_prompts`
SET `author_user_id` = (SELECT `survivor_id` FROM `_account_merge_map` WHERE `loser_id` = `floor_queue_prompts`.`author_user_id`)
WHERE `author_user_id` IN (SELECT `loser_id` FROM `_account_merge_map`);
--> statement-breakpoint

UPDATE `github_connection_states`
SET `user_id` = (SELECT `survivor_id` FROM `_account_merge_map` WHERE `loser_id` = `github_connection_states`.`user_id`)
WHERE `user_id` IN (SELECT `loser_id` FROM `_account_merge_map`);
--> statement-breakpoint

UPDATE `repository_connections`
SET `connected_by` = (SELECT `survivor_id` FROM `_account_merge_map` WHERE `loser_id` = `repository_connections`.`connected_by`)
WHERE `connected_by` IN (SELECT `loser_id` FROM `_account_merge_map`);
--> statement-breakpoint

UPDATE `repository_candidates`
SET `created_by` = (SELECT `survivor_id` FROM `_account_merge_map` WHERE `loser_id` = `repository_candidates`.`created_by`)
WHERE `created_by` IN (SELECT `loser_id` FROM `_account_merge_map`);
--> statement-breakpoint

UPDATE `repository_candidates`
SET `review_ready_by` = (SELECT `survivor_id` FROM `_account_merge_map` WHERE `loser_id` = `repository_candidates`.`review_ready_by`)
WHERE `review_ready_by` IN (SELECT `loser_id` FROM `_account_merge_map`);
--> statement-breakpoint

UPDATE `repository_candidates`
SET `merged_by` = (SELECT `survivor_id` FROM `_account_merge_map` WHERE `loser_id` = `repository_candidates`.`merged_by`)
WHERE `merged_by` IN (SELECT `loser_id` FROM `_account_merge_map`);
--> statement-breakpoint

UPDATE `repository_preflights`
SET `created_by` = (SELECT `survivor_id` FROM `_account_merge_map` WHERE `loser_id` = `repository_preflights`.`created_by`)
WHERE `created_by` IN (SELECT `loser_id` FROM `_account_merge_map`);
--> statement-breakpoint

UPDATE `agent_runs`
SET `created_by` = (SELECT `survivor_id` FROM `_account_merge_map` WHERE `loser_id` = `agent_runs`.`created_by`)
WHERE `created_by` IN (SELECT `loser_id` FROM `_account_merge_map`);
--> statement-breakpoint

UPDATE `agent_runs`
SET `discarded_by` = (SELECT `survivor_id` FROM `_account_merge_map` WHERE `loser_id` = `agent_runs`.`discarded_by`)
WHERE `discarded_by` IN (SELECT `loser_id` FROM `_account_merge_map`);
--> statement-breakpoint

-- Step 5: carry forward onto the survivor whatever it's missing but a
-- duplicate has, so a merge never loses profile data or downgrades billing
-- standing. Applies uniformly to every user (singleton survivors included),
-- for whom every subquery here trivially resolves back to their own row.
UPDATE `users`
SET
  `first_name` = COALESCE(`first_name`, (
    SELECT `r`.`first_name` FROM `_account_rank` `r`
    WHERE `r`.`email` = `users`.`email` AND `r`.`first_name` IS NOT NULL
    ORDER BY `r`.`rnk` ASC LIMIT 1
  )),
  `last_name` = COALESCE(`last_name`, (
    SELECT `r`.`last_name` FROM `_account_rank` `r`
    WHERE `r`.`email` = `users`.`email` AND `r`.`last_name` IS NOT NULL
    ORDER BY `r`.`rnk` ASC LIMIT 1
  )),
  `github_handle` = COALESCE(`github_handle`, (
    SELECT `r`.`github_handle` FROM `_account_rank` `r`
    WHERE `r`.`email` = `users`.`email` AND `r`.`github_handle` IS NOT NULL
    ORDER BY `r`.`rnk` ASC LIMIT 1
  )),
  `avatar_key` = COALESCE(`avatar_key`, (
    SELECT `r`.`avatar_key` FROM `_account_rank` `r`
    WHERE `r`.`email` = `users`.`email` AND `r`.`avatar_key` IS NOT NULL
    ORDER BY `r`.`rnk` ASC LIMIT 1
  )),
  `plan` = (
    SELECT `r`.`plan` FROM `_account_rank` `r`
    WHERE `r`.`email` = `users`.`email`
    ORDER BY `r`.`plan_strength` DESC, `r`.`rnk` ASC LIMIT 1
  ),
  `plan_status` = (
    SELECT `r`.`plan_status` FROM `_account_rank` `r`
    WHERE `r`.`email` = `users`.`email`
    ORDER BY `r`.`plan_strength` DESC, `r`.`rnk` ASC LIMIT 1
  )
WHERE `id` IN (SELECT `survivor_id` FROM `_account_survivor`);
--> statement-breakpoint

-- Step 6: losers are fully dereferenced by every step above — safe to drop.
DELETE FROM `users` WHERE `id` IN (SELECT `loser_id` FROM `_account_merge_map`);
--> statement-breakpoint

DROP TABLE `_account_merge_map`;
--> statement-breakpoint
DROP TABLE `_session_members_final`;
--> statement-breakpoint
DROP TABLE `_floor_assignments_final`;
--> statement-breakpoint
DROP TABLE `_usage_months_final`;
--> statement-breakpoint
DROP TABLE `_account_survivor`;
--> statement-breakpoint
DROP TABLE `_account_rank`;
--> statement-breakpoint

-- Step 7: enforce the invariant going forward. Every duplicate is gone by
-- this point, so this cannot fail — IF NOT EXISTS only guards a second run
-- of this same migration, not a live race (D1 migrations apply serially).
CREATE UNIQUE INDEX IF NOT EXISTS `idx_users_email` ON `users` (`email`);
