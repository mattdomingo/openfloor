import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { detectRepositoryPreview, selectSingleHttpPort } from "../../scripts/repository-preview.mjs";
import { previewSandboxId } from "../../lib/repository-preview-id";

describe("repository preview autodetection", () => {
  it.each([
    ["npm", "package-lock.json", ["npm", "ci"], ["npm", "run", "dev"]],
    ["pnpm", "pnpm-lock.yaml", ["pnpm", "install", "--frozen-lockfile"], ["pnpm", "run", "dev"]],
    ["yarn", "yarn.lock", ["yarn", "install", "--immutable"], ["yarn", "run", "dev"]],
    ["bun", "bun.lock", ["bun", "install", "--frozen-lockfile"], ["bun", "run", "dev"]],
  ])("uses closed frozen commands for %s", (manager, lock, install, run) => {
    expect(detectRepositoryPreview(
      { packageManager: `${manager}@1.0.0`, scripts: { dev: "framework dev" } },
      new Set([lock]),
    )).toEqual({ packageManager: manager, script: "dev", installCommand: install, runCommand: run });
  });

  it("prefers dev over start", () => {
    expect(detectRepositoryPreview({ scripts: { start: "serve", dev: "develop" } }, new Set(["package-lock.json"])).script).toBe("dev");
  });

  it("rejects missing scripts, missing locks, lock conflicts, and declaration conflicts", () => {
    expect(() => detectRepositoryPreview({ scripts: {} }, new Set(["package-lock.json"]))).toThrow("no supported dev or start script");
    expect(() => detectRepositoryPreview({ scripts: { dev: "x" } }, new Set())).toThrow("requires a supported frozen lockfile");
    expect(() => detectRepositoryPreview({ scripts: { dev: "x" } }, new Set(["package-lock.json", "yarn.lock"]))).toThrow("ambiguous");
    expect(() => detectRepositoryPreview({ scripts: { dev: "x" } }, new Set(["package-lock.json", "npm-shrinkwrap.json"]))).toThrow("ambiguous");
    expect(() => detectRepositoryPreview({ packageManager: "pnpm@10", scripts: { dev: "x" } }, new Set(["package-lock.json"]))).toThrow("conflicts");
  });

  it("rejects multiple HTTP listeners", () => {
    expect(selectSingleHttpPort([])).toBeNull();
    expect(selectSingleHttpPort([3000])).toBe(3000);
    expect(() => selectSingleHttpPort([3000, 4173])).toThrow("multiple HTTP listeners");
  });
});

describe("repository preview sandbox posture", () => {
  it("uses generation-scoped normalized sandbox IDs", () => {
    expect(previewSandboxId()).toMatch(/^preview-v5-[0-9a-f]{32}$/);
  });

  it("isolates runtime network and relays only through a Unix socket", () => {
    const workflow = readFileSync(new URL("../../worker/preview-workflow.ts", import.meta.url), "utf8");
    const runtime = readFileSync(new URL("../../scripts/preview-runtime.mjs", import.meta.url), "utf8");
    expect(workflow).toContain("bwrap --die-with-parent --unshare-net");
    expect(workflow).toContain("UNIX-CONNECT:/workspace/preview.sock");
    expect(workflow).toContain("TCP-LISTEN:${RELAY_PORT}");
    expect(runtime).not.toContain('process.env[name]');
    expect(runtime).not.toContain("NODE_OPTIONS");
  });
});
