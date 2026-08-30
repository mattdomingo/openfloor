import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const preload = resolve("scripts/runner-env-preload.mjs");
const forkFixture = resolve("tests/fixtures/runner-env-child.mjs");

function runProbe(script: string) {
  return spawnSync(process.execPath, ["--import", preload, "-e", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: "anthropic-secret",
      DASHSCOPE_API_KEY: "dashscope-secret",
      OPENFLOOR_TEST_TOKEN: "openfloor-secret",
      RUNTIME_GATEWAY_SECRET: "gateway-secret",
    },
  });
}

describe("agent runner environment hardening", () => {
  it("removes gateway tokens from repository-controlled child processes", () => {
    const script = `const c=require("child_process").spawn(process.execPath,["-e","process.stdout.write(process.env.OPENFLOOR_TEST_TOKEN||'clean')"]);c.stdout.pipe(process.stdout)`;
    const result = runProbe(script);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("clean");
  });

  it("keeps only explicit built-in MCP tokens and gives Codex an explicit safe environment", () => {
    const mcpScript = `const c=require("child_process").spawn(process.execPath,["/opt/openfloor/openfloor-mcp.mjs"],{env:{OPENFLOOR_CONTEXT_TOKEN:'bridge',OPENAI_API_KEY:'gateway'}});process.stdout.write(JSON.stringify(c.spawnargs)+'\\n'+JSON.stringify(c.spawnfile)+'\\n'+String(c.pid>0));c.kill()`;
    const result = spawnSync(process.execPath, ["--import", preload, "-e", mcpScript], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("openfloor-mcp.mjs");
    const codexRunner = readFileSync(resolve("scripts/codex-runner.mjs"), "utf8");
    expect(codexRunner).toContain('env: safeCliEnvironment');
    expect(codexRunner).toContain('shell_environment_policy: { inherit: "none", set: safeCliEnvironment }');
  });

  it("does not treat a shell command mentioning the MCP filename as the trusted bridge", () => {
    const script = `const c=require("child_process").spawn(process.execPath,["-e","process.stdout.write(process.env.OPENFLOOR_TEST_TOKEN||'clean')","openfloor-mcp.mjs"]);c.stdout.pipe(process.stdout)`;
    const result = runProbe(script);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("clean");
  });

  it("scrubs spawn and spawnSync option-only overloads without dropping options", () => {
    const asynchronous = runProbe(`const c=require("node:child_process").spawn('printf "%s|%s" "$PWD" "\${OPENFLOOR_TEST_TOKEN:-clean}"',{shell:true,cwd:"/"});c.stdout.pipe(process.stdout)`);
    expect(asynchronous.status).toBe(0);
    expect(asynchronous.stdout).toBe("/|clean");

    const synchronous = runProbe(`const c=require("node:child_process").spawnSync('printf "%s|%s" "$PWD" "\${ANTHROPIC_API_KEY:-clean}"',{shell:true,cwd:"/",encoding:"utf8"});process.stdout.write(c.stdout)`);
    expect(synchronous.status).toBe(0);
    expect(synchronous.stdout).toBe("/|clean");
  });

  it("scrubs execSync and fork while preserving safe command environment", () => {
    const execResult = runProbe(`const {execSync}=require("node:child_process");process.stdout.write(execSync('printf "%s|%s|%s" "\${RUNTIME_GATEWAY_SECRET:-clean}" "\${PATH:+path}" "\${HOME:+home}"',{encoding:"utf8"}))`);
    expect(execResult.status).toBe(0);
    expect(execResult.stdout).toBe("clean|path|home");

    const forkResult = runProbe(`const {fork}=require("node:child_process");const c=fork(${JSON.stringify(forkFixture)},{silent:true});c.stdout.pipe(process.stdout)`);
    expect(forkResult.status).toBe(0);
    expect(forkResult.stdout).toBe("clean|path|home");
  });
});
