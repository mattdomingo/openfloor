import { defineConfig } from "@playwright/test";

const port = process.env.OPENFLOOR_E2E_PORT ?? "8787";
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: origin,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node tests/e2e/server.mjs",
    url: `${origin}/app`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
