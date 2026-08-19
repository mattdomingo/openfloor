import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

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
        bindings: { INVITE_SIGNING_SECRET: "render-test-secret" },
      },
    }),
  ],
  test: { include: ["tests/render/**/*.test.ts"] },
});
