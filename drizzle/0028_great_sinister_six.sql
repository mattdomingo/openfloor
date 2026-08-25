ALTER TABLE `floor_agents` ADD `deprovisioned_at` integer;--> statement-breakpoint
CREATE INDEX `idx_floor_agents_session_active` ON `floor_agents` (`session_id`,`deprovisioned_at`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `auto_provision_agents` integer DEFAULT true NOT NULL;--> statement-breakpoint
UPDATE `sessions` SET `auto_provision_agents` = false;--> statement-breakpoint
ALTER TABLE `sessions` ADD `auto_agent_provider` text;--> statement-breakpoint
UPDATE `floor_agents`
SET `deprovisioned_at` = CAST(strftime('%s', 'now') AS integer) * 1000,
    `updated_at` = CAST(strftime('%s', 'now') AS integer) * 1000
WHERE `kind` = 'answer'
  AND NOT EXISTS (
    SELECT 1 FROM `floor_queue_items` q
    WHERE q.`agent_id` = `floor_agents`.`id`
      AND q.`status` IN ('queued', 'running', 'blocked', 'paused')
  )
  AND NOT EXISTS (
    SELECT 1 FROM `agent_runs` r
    WHERE r.`agent_id` = `floor_agents`.`id`
      AND r.`status` IN ('provisioning', 'running', 'checking', 'cancel_requested', 'publishing', 'published', 'integrating')
  );
