CREATE TABLE `storage_cleanup_prefixes` (
	`bucket` text NOT NULL,
	`prefix` text NOT NULL,
	`source_session_id` text,
	`not_before` integer NOT NULL,
	`last_scanned_at` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`bucket`, `prefix`)
);
--> statement-breakpoint
CREATE INDEX `idx_storage_cleanup_due` ON `storage_cleanup_prefixes` (`not_before`,`updated_at`);
--> statement-breakpoint
UPDATE floor_agents
SET paused_at = COALESCE(paused_at, CAST(strftime('%s','now') AS INTEGER) * 1000),
    updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE kind IS NULL AND deprovisioned_at IS NULL AND created_by <> owner_user_id;
