import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./drizzle");

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
        },
      },
    }),
  ],
  test: {
    include: ["tests/worker/**/*.test.ts"],
    setupFiles: ["./tests/worker/setup.ts"],
  },
});
