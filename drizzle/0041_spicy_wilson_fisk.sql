ALTER TABLE `floor_queue_items` ADD `origin` text;--> statement-breakpoint
ALTER TABLE `repository_candidates` ADD `review_decision` text;--> statement-breakpoint
ALTER TABLE `repository_candidates` ADD `feedback_nudges` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `auto_inject_feedback` integer DEFAULT true NOT NULL;