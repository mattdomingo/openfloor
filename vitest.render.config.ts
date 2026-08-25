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
          CREDENTIAL_ENCRYPTION_KEY: "render-test-credential-encryption-key",
          OPENFLOOR_TEST_PROVIDER_KEYS: JSON.stringify({
            anthropic: ["sk-ant-render-accepted"],
            openai: ["sk-openai-render-accepted"],
            kimi: ["sk-kimi-render-accepted"],
            gemini: ["AIza-gemini-render-accepted"],
          }),
          TEST_MIGRATIONS: JSON.stringify(migrations),
        },
      },
    }),
  ],
  test: { include: ["tests/render/**/*.test.ts"], setupFiles: ["./tests/render/setup.ts"] },
});
