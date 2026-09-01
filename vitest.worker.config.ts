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
const autoAgentMigration = migrations.find((migration) => migration.name.startsWith("0028_"));
if (!autoAgentMigration) throw new Error("Expected drizzle/0028_*.sql (the auto-agent migration) to exist.");
const autoAgentDataQueries = autoAgentMigration.queries.filter((query) => query.trimStart().startsWith("UPDATE"));
const accountGitHubMigration = migrations.find((migration) => migration.name.startsWith("0032_"));
if (!accountGitHubMigration) throw new Error("Expected drizzle/0032_*.sql (the account GitHub migration) to exist.");
const agentBillingMigration = migrations.find((migration) => migration.name.startsWith("0042_"));
if (!agentBillingMigration) throw new Error("Expected drizzle/0042_*.sql (the agent billing quarantine migration) to exist.");
const agentBillingDataQueries = agentBillingMigration.queries.filter((query) => query.trimStart().startsWith("UPDATE floor_agents"));

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
          STRIPE_SECRET_KEY: "sk_test_worker",
          STRIPE_WEBHOOK_SECRET: "whsec_worker-test-stripe-webhook-secret",
          STRIPE_PRO_PRICE_ID: "price_test_pro",
          STRIPE_MAX_PRICE_ID: "price_test_max",
          STRIPE_PORTAL_CONFIGURATION_ID: "bpc_test",
          STRIPE_CHECKOUT_ENABLED: "true",
          EARLY_ACCESS_GATE_ENABLED: "false",
          EARLY_ACCESS_PASSWORD: "worker-test-early-access-password",
          WAITLIST_SHEET_WEBHOOK_SECRET: "worker-test-waitlist-sheet-secret",
          OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS: "true",
          RUNTIME_GATEWAY_SECRET: "worker-test-runtime-gateway-secret",
          CREDENTIAL_ENCRYPTION_KEY: "worker-test-credential-encryption-key",
          TEST_MIGRATIONS: JSON.stringify(migrations),
          ACCOUNT_EMAIL_MERGE_QUERIES: JSON.stringify(accountEmailMergeMigration.queries),
          AUTO_AGENT_DATA_MIGRATION_QUERIES: JSON.stringify(autoAgentDataQueries),
          ACCOUNT_GITHUB_MIGRATION_QUERIES: JSON.stringify(accountGitHubMigration.queries),
          AGENT_BILLING_QUARANTINE_QUERIES: JSON.stringify(agentBillingDataQueries),
        },
      },
    }),
  ],
  test: {
    include: ["tests/worker/**/*.test.ts"],
    setupFiles: ["./tests/worker/setup.ts"],
    testTimeout: 15000,
  },
});
