ALTER TABLE `floor_queue_items` ADD `dismissed_at` integer;--> statement-breakpoint
-- One-time backfill: auto-dispatch now defaults on for new sessions
-- (db/sessions.ts createSession), and every existing live session gets the
-- same default so no session is stuck with unassigned prompts and no Run
-- button. An owner who wants it off can still toggle it off afterward.
UPDATE `sessions` SET `auto_dispatch` = 1 WHERE `ended_at` IS NULL;
