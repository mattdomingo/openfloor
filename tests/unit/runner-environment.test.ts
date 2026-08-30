import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const preload = resolve("scripts/runner-env-preload.mjs");

describe("agent runner environment hardening", () => {
  it("removes gateway tokens from repository-controlled child processes", () => {
    const script = `const c=require("child_process").spawn(process.execPath,["-e","process.stdout.write(process.env.OPENFLOOR_TEST_TOKEN||'clean')"]);c.stdout.pipe(process.stdout)`;
    const result = spawnSync(process.execPath, ["--import", preload, "-e", script], {
      encoding: "utf8",
      env: { ...process.env, OPENFLOOR_TEST_TOKEN: "secret" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("clean");
  });

  it("keeps only explicit built-in MCP tokens and configures Codex with no shell inheritance", () => {
    const mcpScript = `const c=require("child_process").spawn(process.execPath,["/opt/openfloor/openfloor-mcp.mjs"],{env:{OPENFLOOR_CONTEXT_TOKEN:'bridge',OPENAI_API_KEY:'gateway'}});process.stdout.write(JSON.stringify(c.spawnargs)+'\\n'+JSON.stringify(c.spawnfile)+'\\n'+String(c.pid>0));c.kill()`;
    const result = spawnSync(process.execPath, ["--import", preload, "-e", mcpScript], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("openfloor-mcp.mjs");
    expect(readFileSync(resolve("scripts/codex-runner.mjs"), "utf8")).toContain('shell_environment_policy: { inherit: "none" }');
  });

  it("does not treat a shell command mentioning the MCP filename as the trusted bridge", () => {
    const script = `const c=require("child_process").spawn(process.execPath,["-e","process.stdout.write(process.env.OPENFLOOR_TEST_TOKEN||'clean')","openfloor-mcp.mjs"]);c.stdout.pipe(process.stdout)`;
    const result = spawnSync(process.execPath, ["--import", preload, "-e", script], {
      encoding: "utf8",
      env: { ...process.env, OPENFLOOR_TEST_TOKEN: "secret" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("clean");
  });
});
