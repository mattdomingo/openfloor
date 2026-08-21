import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./drizzle");
// tests/worker/account-merge.test.ts re-runs this one migration's exact
// statements against seeded duplicate data (dropping idx_users_email first,
// since the migration file itself creates it) — reusing wrangler's own SQL
// splitting here, rather than the test file parsing the .sql on its own,
// guarantees the test executes precisely what applyD1Migrations would.
const accountEmailMergeMigration = migrations.find((migration) => migration.name.startsWith("0022_"));
if (!accountEmailMergeMigration) throw new Error("Expected drizzle/0022_*.sql (the account email merge migration) to exist.");

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  plugins: [
    cloudflareTest({
      main: "./tests/worker/entry.ts",
      miniflare: {
        compatibilityDate: "2026-05-22",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        durableObjects: { SESSION_PRESENCE: "SessionPresence" },
        bindings: {
          INVITE_SIGNING_SECRET: "worker-test-invite-secret",
          GITHUB_APP_ID: "test-app",
          GITHUB_APP_SLUG: "openfloor-test",
          GITHUB_APP_PRIVATE_KEY: "test-private-key",
          GITHUB_STATE_SECRET: "worker-test-github-state-secret",
          GITHUB_WEBHOOK_SECRET: "worker-test-github-webhook-secret",
          OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS: "true",
          RUNTIME_GATEWAY_SECRET: "worker-test-runtime-gateway-secret",
          TEST_MIGRATIONS: JSON.stringify(migrations),
          ACCOUNT_EMAIL_MERGE_QUERIES: JSON.stringify(accountEmailMergeMigration.queries),
        },
      },
    }),
  ],
  test: {
    include: ["tests/worker/**/*.test.ts"],
    setupFiles: ["./tests/worker/setup.ts"],
  },
});
