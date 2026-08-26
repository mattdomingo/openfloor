import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    environment: "node",
    // .tsx so a component that is pure enough to render to a string (the
    // markdown renderer) can be checked here rather than in the slower
    // build-and-serve render suite.
    include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx"],
    // Git subprocess-heavy repository tests can exceed Vitest's 5-second
    // default on shared CI hosts; their assertions remain bounded by this
    // suite-level timeout.
    testTimeout: 60_000,
  },
});
