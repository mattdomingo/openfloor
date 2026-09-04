import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const verifier = resolve("scripts/verify-deploy-artifact.mjs");
const productionConfig = {
  name: "openfloor",
  routes: [{ pattern: "app.opnflr.com", custom_domain: true }],
  d1_databases: [{
    binding: "DB",
    database_name: "openfloor-production",
    database_id: "1e5059bf-1f7b-4be8-8ea4-c424a191070a",
  }],
  r2_buckets: [
    { binding: "PREFLIGHT_LOGS", bucket_name: "openfloor-preflight-logs" },
    { binding: "USER_AVATARS", bucket_name: "openfloor-user-avatars" },
  ],
  workflows: [
    { binding: "REPOSITORY_PREFLIGHT", name: "openfloor-repository-preflight" },
    { binding: "AGENT_RUN_WORKFLOW", name: "openfloor-agent-run" },
    { binding: "REPOSITORY_PREVIEW", name: "openfloor-repository-preview" },
  ],
  vars: {
    OPENFLOOR_RUNTIME_ORIGIN: "https://app.opnflr.com",
    AGENT_RUN_ENABLED: "true",
    OPENFLOOR_PREVIEW_HOSTNAME: "preview.opnflr.com",
    REPOSITORY_PREVIEW_ENABLED: "false",
  },
};
const developmentConfig = {
  name: "openfloor-development",
  routes: [{ pattern: "dev.app.opnflr.com", custom_domain: true }],
  d1_databases: [{
    binding: "DB",
    database_name: "openfloor-development",
    database_id: "fe7e3046-8cd8-4aae-a226-87534b2d9f15",
  }],
  r2_buckets: [
    { binding: "PREFLIGHT_LOGS", bucket_name: "openfloor-development-preflight-logs" },
    { binding: "USER_AVATARS", bucket_name: "openfloor-development-user-avatars" },
  ],
  workflows: [
    { binding: "REPOSITORY_PREFLIGHT", name: "openfloor-development-repository-preflight" },
    { binding: "AGENT_RUN_WORKFLOW", name: "openfloor-development-agent-run" },
    { binding: "REPOSITORY_PREVIEW", name: "openfloor-development-repository-preview" },
  ],
  vars: {
    OPENFLOOR_RUNTIME_ORIGIN: "https://dev.app.opnflr.com",
    AGENT_RUN_ENABLED: "true",
    OPENFLOOR_PREVIEW_HOSTNAME: "preview.dev.opnflr.com",
    REPOSITORY_PREVIEW_ENABLED: "false",
    STRIPE_CHECKOUT_ENABLED: "false",
    EARLY_ACCESS_GATE_ENABLED: "false",
  },
};

function verify(config: unknown, target?: "production" | "development") {
  const directory = mkdtempSync(join(tmpdir(), "openfloor-deploy-artifact-"));
  try {
    mkdirSync(join(directory, "dist/server"), { recursive: true });
    writeFileSync(join(directory, "dist/server/wrangler.json"), JSON.stringify(config));
    return spawnSync(process.execPath, [verifier, ...(target ? [target] : [])], {
      cwd: directory,
      encoding: "utf8",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("deploy artifact verifier", () => {
  it("accepts the exact production identity by default", () => {
    const result = verify(productionConfig);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("verified as the production openfloor artifact");
  });

  it("accepts the isolated development environment", () => {
    const result = verify(developmentConfig, "development");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("verified as the development openfloor-development artifact");
  });

  it("rejects a lookalike production D1 binding whose display name hides the wrong id", () => {
    const result = verify({
      ...productionConfig,
      d1_databases: [{
        ...productionConfig.d1_databases[0],
        database_id: "00000000-0000-0000-0000-000000000000",
      }],
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("expected production id");
  });

  it("rejects any production resource leaked into development", () => {
    const result = verify({
      ...developmentConfig,
      r2_buckets: productionConfig.r2_buckets,
    }, "development");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('PREFLIGHT_LOGS points at "openfloor-preflight-logs"');
    expect(result.stderr).toContain('USER_AVATARS points at "openfloor-user-avatars"');
  });

  it("rejects a disabled development execution gate", () => {
    const result = verify({
      ...developmentConfig,
      vars: {
        ...developmentConfig.vars,
        AGENT_RUN_ENABLED: "false",
      },
    }, "development");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AGENT_RUN_ENABLED is "false"');
  });

  it("rejects a mismatched rollout posture and test-only variables", () => {
    const result = verify({
      ...productionConfig,
      vars: {
        ...productionConfig.vars,
        AGENT_RUN_ENABLED: "false",
        OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS: "true",
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AGENT_RUN_ENABLED is "false"');
    expect(result.stderr).toContain("test-only var OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS is present");
  });
});
