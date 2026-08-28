import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const statePath = mkdtempSync(join(tmpdir(), "openfloor-e2e-"));
const port = process.env.OPENFLOOR_E2E_PORT ?? "8787";
const githubTestData = JSON.stringify({
  installationId: "test-installation",
  repositories: [{
    id: "9001",
    nodeId: "R_test_repository",
    owner: "openfloor-test",
    name: "repository-integration",
    fullName: "openfloor-test/repository-integration",
    private: true,
    defaultBranch: "main",
    branches: ["main", "develop"],
    files: {
      "README.md": "# repository-integration\n\nFixture repository for e2e tests.\n",
      "src/index.ts": "export const entry = true;\n",
      "src/agent-change.ts": "export const implemented = false;\n",
    },
  }],
});
const wranglerConfig = "tests/e2e/wrangler.jsonc";
const providerTestKeys = JSON.stringify({
  anthropic: ["sk-ant-e2e-accepted"],
  openai: ["sk-openai-e2e-accepted"],
  kimi: ["sk-kimi-e2e-accepted"],
  gemini: ["AIza-gemini-e2e-accepted"],
  glm: ["zai-glm-e2e-accepted"],
});
const agentRunTestData = process.env.OPENFLOOR_TEST_AGENT_RUN_DATA ?? JSON.stringify({
  holdPrompts: ["Hold for cancellation", "Hold persistent for auto provisioning", "Hold generated for auto provisioning"],
  failPrompts: ["intentionally failing"],
  conflictFirstAttemptPrompts: [
    "deliberate integration conflict",
    "conflict needing a session decision",
    "manual merge conflict",
    "candidate movement conflict",
    "resolver check failure",
  ],
  resolverQuestionPrompts: ["conflict needing a session decision"],
  resolverConflictFirstAttemptPrompts: ["candidate movement conflict"],
  resolverFailFirstAttemptPrompts: ["resolver check failure"],
  // Pause briefly between run stages (and broadcast floor.changed at each) so
  // the browser actually renders intermediate states — without this, runs
  // execute faster than the client refetches and asserts on transient labels
  // like "Merge Resolver" become a reload-speed race.
  stageDelayMs: 250,
  changedPath: "src/agent-change.ts",
  pathByPrompt: { "second published": "src/second-change.ts", "member rollback": "src/member-change.ts" },
});
const migration = spawnSync(
  "npx",
  ["wrangler", "d1", "migrations", "apply", "DB", "--local", "--config", wranglerConfig, "--persist-to", statePath],
  { stdio: "inherit" },
);

if (migration.status !== 0) {
  rmSync(statePath, { recursive: true, force: true });
  process.exit(migration.status ?? 1);
}

const server = spawn("npx", [
  "wrangler",
  "dev",
  "--config",
  wranglerConfig,
  "--port",
  port,
  "--persist-to",
  statePath,
  "--var",
  "INVITE_SIGNING_SECRET:e2e-test-secret",
  "GITHUB_APP_ID:test-app",
  "GITHUB_APP_SLUG:openfloor-test",
  "GITHUB_APP_PRIVATE_KEY:test-private-key",
  "GITHUB_STATE_SECRET:e2e-test-github-state-secret",
  "GITHUB_WEBHOOK_SECRET:e2e-test-github-webhook-secret",
  "STRIPE_SECRET_KEY:sk_test_e2e",
  "STRIPE_WEBHOOK_SECRET:whsec_e2e-test-stripe-webhook-secret",
  "STRIPE_PRO_PRICE_ID:price_test_pro",
  "STRIPE_MAX_PRICE_ID:price_test_max",
  "STRIPE_PORTAL_CONFIGURATION_ID:bpc_test",
  "STRIPE_CHECKOUT_ENABLED:true",
  "CREDENTIAL_ENCRYPTION_KEY:e2e-test-credential-encryption-key",
  `OPENFLOOR_TEST_PROVIDER_KEYS:${providerTestKeys}`,
  `OPENFLOOR_TEST_GITHUB_DATA:${githubTestData}`,
  "PREFLIGHT_ENABLED:false",
  "AGENT_RUN_ENABLED:true",
  `OPENFLOOR_TEST_AGENT_RUN_DATA:${agentRunTestData}`,
  "--var",
  "OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS:true",
  "--show-interactive-dev-session=false",
], { stdio: "inherit" });

function stop(signal) {
  server.kill(signal);
  rmSync(statePath, { recursive: true, force: true });
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
server.on("exit", (code) => {
  rmSync(statePath, { recursive: true, force: true });
  process.exit(code ?? 0);
});
