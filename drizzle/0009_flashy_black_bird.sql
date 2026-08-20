ALTER TABLE `repository_candidates` ADD `name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `repository_candidates` ADD `description` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `repository_candidates`
SET `name` = COALESCE((SELECT `title` FROM `sessions` WHERE `sessions`.`id` = `repository_candidates`.`session_id`), `branch_name`),
    `description` = COALESCE((SELECT `objective` FROM `sessions` WHERE `sessions`.`id` = `repository_candidates`.`session_id`), '');
