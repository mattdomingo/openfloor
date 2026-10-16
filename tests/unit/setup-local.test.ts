import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const script = resolve("scripts/setup-local.mjs");

function withFixture(run: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "openfloor-local-setup-"));
  try {
    writeFileSync(join(directory, "wrangler.jsonc"), `{
      // Retain real bindings while choosing safe local defaults.
      "name": "openfloor",
      "d1_databases": [{ "binding": "DB", "database_id": "example" }],
      "vars": { "AGENT_RUN_ENABLED": "true", "STRIPE_CHECKOUT_ENABLED": "true" }
    }`);
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("local developer setup", () => {
  it("generates private local secrets without logging them, closes external gates, and is repeatable", () => {
    withFixture((directory) => {
      const result = spawnSync(process.execPath, [script], { cwd: directory, encoding: "utf8" });
      expect(result.status).toBe(0);
      const variables = readFileSync(join(directory, ".dev.vars"), "utf8");
      const secret = variables.match(/^INVITE_SIGNING_SECRET="([a-f0-9]{64})"$/m)?.[1];
      expect(secret).toHaveLength(64);
      expect(result.stdout).not.toContain(secret);
      expect(statSync(join(directory, ".dev.vars")).mode & 0o777).toBe(0o600);
      const config = JSON.parse(readFileSync(join(directory, ".wrangler.local.jsonc"), "utf8"));
      expect(config.d1_databases).toEqual([{ binding: "DB", database_id: "example" }]);
      expect(config.dev.enable_containers).toBe(false);
      expect(config.vars).toMatchObject({
        AGENT_RUN_ENABLED: "false", STRIPE_CHECKOUT_ENABLED: "false", PREFLIGHT_ENABLED: "false",
      });
      writeFileSync(join(directory, ".wrangler.local.jsonc"), "developer override\n");
      const repeated = spawnSync(process.execPath, [script], { cwd: directory, encoding: "utf8" });
      expect(repeated.status).toBe(0);
      expect(readFileSync(join(directory, ".dev.vars"), "utf8")).toBe(variables);
      expect(readFileSync(join(directory, ".wrangler.local.jsonc"), "utf8")).toBe("developer override\n");
    });
  });

  it.each(["{ invalid", "null", "[]"])("refuses invalid source configuration %s before creating local files", (source) => {
    withFixture((directory) => {
      writeFileSync(join(directory, "wrangler.jsonc"), source);
      const result = spawnSync(process.execPath, [script], { cwd: directory, encoding: "utf8" });
      expect(result.status).not.toBe(0);
      expect(() => readFileSync(join(directory, ".dev.vars"))).toThrow();
      expect(() => readFileSync(join(directory, ".wrangler.local.jsonc"))).toThrow();
    });
  });
});
