import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const statePath = mkdtempSync(join(tmpdir(), "openfloor-e2e-"));
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
  }],
});
const wranglerConfig = "tests/e2e/wrangler.jsonc";
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
  "8787",
  "--persist-to",
  statePath,
  "--var",
  "INVITE_SIGNING_SECRET:e2e-test-secret",
  "GITHUB_APP_ID:test-app",
  "GITHUB_APP_SLUG:openfloor-test",
  "GITHUB_APP_PRIVATE_KEY:test-private-key",
  "GITHUB_STATE_SECRET:e2e-test-github-state-secret",
  "GITHUB_WEBHOOK_SECRET:e2e-test-github-webhook-secret",
  `OPENFLOOR_TEST_GITHUB_DATA:${githubTestData}`,
  "PREFLIGHT_ENABLED:true",
  "AGENT_RUN_ENABLED:true",
  "OPENFLOOR_TEST_PREFLIGHT_DATA:{\"checks\":[{\"exitCode\":0,\"stdout\":\"preflight check passed\\n\"},{\"exitCode\":0,\"stdout\":\"build check passed\\n\"}],\"failCommands\":[\"false\"]}",
  "OPENFLOOR_TEST_AGENT_RUN_DATA:{\"holdPrompts\":[\"Hold for cancellation\"],\"failPrompts\":[\"intentionally failing\"],\"conflictFirstAttemptPrompts\":[\"deliberate integration conflict\"],\"changedPath\":\"src/agent-change.ts\",\"pathByPrompt\":{\"second published\":\"src/second-change.ts\"}}",
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
