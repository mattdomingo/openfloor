import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const identity = {
  GIT_AUTHOR_NAME: "openfloor", GIT_AUTHOR_EMAIL: "runtime@opnflr.com",
  GIT_COMMITTER_NAME: "openfloor", GIT_COMMITTER_EMAIL: "runtime@opnflr.com",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...identity }, encoding: "utf8" }).trim();
}

function baseline(cwd: string) {
  git(cwd, "add", "-A");
  const tree = git(cwd, "write-tree");
  return execFileSync("git", ["commit-tree", tree], { cwd, env: { ...process.env, ...identity }, input: "openfloor candidate baseline\n", encoding: "utf8" }).trim();
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("resolver three-way workspace", () => {
  it("produces genuine multi-file conflicts then converts resolution back to publisher baseline", () => {
    const root = mkdtempSync(join(tmpdir(), "openfloor-conflict-"));
    roots.push(root);
    const source = join(root, "source");
    const latest = join(root, "latest");
    mkdirSync(source); mkdirSync(latest);
    for (const repo of [source, latest]) { git(repo, "init", "-q"); git(repo, "config", "user.name", "openfloor"); git(repo, "config", "user.email", "runtime@opnflr.com"); }
    writeFileSync(join(source, "a.ts"), "export const mode = 'base';\n");
    writeFileSync(join(source, "b.ts"), "export const limit = 1;\n");
    const sourceBase = baseline(source);
    git(source, "update-ref", "refs/heads/openfloor-base", sourceBase);
    git(source, "reset", "-q", "--hard", sourceBase);
    writeFileSync(join(source, "a.ts"), "export const mode = 'source';\n");
    writeFileSync(join(source, "b.ts"), "export const limit = 2;\n");
    git(source, "add", "-A"); git(source, "commit", "-q", "-m", "source result");
    const sourceResult = git(source, "rev-parse", "HEAD");

    writeFileSync(join(latest, "a.ts"), "export const mode = 'latest';\n");
    writeFileSync(join(latest, "b.ts"), "export const limit = 3;\n");
    writeFileSync(join(latest, "integrated.ts"), "export const kept = true;\n");
    const publisherBase = baseline(latest);
    git(latest, "update-ref", "refs/heads/openfloor-base", publisherBase);
    git(latest, "reset", "-q", "--hard", publisherBase);
    git(latest, "fetch", "-q", source, `${sourceBase}:refs/heads/source-base`, `${sourceResult}:refs/heads/source-result`);
    const latestTree = git(latest, "write-tree");
    const mergeHead = execFileSync("git", ["commit-tree", latestTree, "-p", sourceBase], { cwd: latest, env: { ...process.env, ...identity }, input: "openfloor latest candidate\n", encoding: "utf8" }).trim();
    git(latest, "reset", "-q", "--hard", mergeHead);
    expect(() => git(latest, "merge", "--no-commit", "--no-ff", "refs/heads/source-result")).toThrow();
    expect(git(latest, "diff", "--name-only", "--diff-filter=U").split("\n")).toEqual(["a.ts", "b.ts"]);
    expect(readFileSync(join(latest, "a.ts"), "utf8")).toContain("<<<<<<< HEAD");

    writeFileSync(join(latest, "a.ts"), "export const mode = 'latest-and-source';\n");
    writeFileSync(join(latest, "b.ts"), "export const limit = 3; // preserve latest policy\n");
    git(latest, "add", "-A");
    expect(git(latest, "ls-files", "-u")).toBe("");
    git(latest, "diff", "--cached", "--check");
    git(latest, "reset", "-q", "refs/heads/openfloor-base");
    expect(git(latest, "rev-parse", "HEAD")).toBe(publisherBase);
    expect(git(latest, "diff", "--name-only", "HEAD").split("\n")).toEqual(["a.ts", "b.ts"]);
    expect(readFileSync(join(latest, "integrated.ts"), "utf8")).toContain("kept");
  }, 15_000);
});
