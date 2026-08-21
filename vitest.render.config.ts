import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./drizzle");

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./dist/server/index.js",
      miniflare: {
        compatibilityDate: "2026-05-22",
        compatibilityFlags: ["nodejs_compat"],
        assets: { directory: "./dist/client", binding: "ASSETS", run_worker_first: true },
        d1Databases: ["DB"],
        durableObjects: { SESSION_PRESENCE: "SessionPresence" },
        bindings: {
          INVITE_SIGNING_SECRET: "render-test-secret",
          OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS: "true",
          TEST_MIGRATIONS: JSON.stringify(migrations),
        },
      },
    }),
  ],
  test: { include: ["tests/render/**/*.test.ts"], setupFiles: ["./tests/render/setup.ts"] },
});
