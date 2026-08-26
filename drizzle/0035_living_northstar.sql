CREATE TABLE `provider_spend_months` (
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`kind` text NOT NULL,
	`month` text NOT NULL,
	`micro_usd` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `provider`, `kind`, `month`)
);
--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `input_tokens` integer;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `output_tokens` integer;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `cache_read_tokens` integer;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `cache_write_tokens` integer;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `cost_micro_usd` integer;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `cost_source` text;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `billed_kind` text;--> statement-breakpoint
ALTER TABLE `user_provider_credentials` ADD `monthly_limit_micro_usd` integer;