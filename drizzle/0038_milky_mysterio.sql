ALTER TABLE `user_github_installations` ADD `repo_scope` text;--> statement-breakpoint
UPDATE `user_github_installations` SET `repo_scope` = '[]';
