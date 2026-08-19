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
          OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS: "true",
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
