PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_user_provider_credentials` (
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`kind` text DEFAULT 'api_key' NOT NULL,
	`ciphertext` text NOT NULL,
	`fingerprint` text NOT NULL,
	`validated_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `provider`, `kind`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_user_provider_credentials`("user_id", "provider", "kind", "ciphertext", "fingerprint", "validated_at", "created_at", "updated_at") SELECT "user_id", "provider", "kind", "ciphertext", "fingerprint", "validated_at", "created_at", "updated_at" FROM `user_provider_credentials`;--> statement-breakpoint
DROP TABLE `user_provider_credentials`;--> statement-breakpoint
ALTER TABLE `__new_user_provider_credentials` RENAME TO `user_provider_credentials`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `floor_agents` ADD `credential_kind` text;