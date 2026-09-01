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
  vars: { AGENT_RUN_ENABLED: "true" },
};

function verify(config: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "openfloor-deploy-artifact-"));
  try {
    mkdirSync(join(directory, "dist/server"), { recursive: true });
    writeFileSync(join(directory, "dist/server/wrangler.json"), JSON.stringify(config));
    return spawnSync(process.execPath, [verifier], { cwd: directory, encoding: "utf8" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("production deploy artifact verifier", () => {
  it("accepts the exact production identity and enabled beta execution gate", () => {
    const result = verify(productionConfig);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("verified as the production openfloor artifact");
  });

  it("rejects a lookalike D1 binding whose display name hides the wrong database id", () => {
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

  it("rejects disabled agent execution and test-only variables", () => {
    const result = verify({
      ...productionConfig,
      vars: {
        AGENT_RUN_ENABLED: "false",
        OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS: "true",
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AGENT_RUN_ENABLED is "false"');
    expect(result.stderr).toContain("test-only var OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS is present");
  });
});
