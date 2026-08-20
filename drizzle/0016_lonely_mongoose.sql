ALTER TABLE `sessions` ADD `objective_updated_at` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `sessions` SET `objective_updated_at` = `updated_at` WHERE `objective_updated_at` = 0;