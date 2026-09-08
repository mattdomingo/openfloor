-- A pre-attribution account: onboarded before verified GitHub identities were stored.
INSERT INTO users (id, chatgpt_user_id, email, display_name, first_name, last_name, onboarded_at, created_at, updated_at)
VALUES ('12345678-1234-4234-8234-123456789abc', 'legacy-attribution-e2e', 'legacy-attribution@example.com', 'Legacy E.', 'Legacy', 'Engineer', 1, 1, 1);
