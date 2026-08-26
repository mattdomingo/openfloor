import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    // Git subprocess-heavy repository tests can exceed Vitest's 5-second
    // default on shared CI hosts; their assertions remain bounded by this
    // suite-level timeout.
    testTimeout: 60_000,
  },
});
