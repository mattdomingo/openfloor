import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { applyManualConflictResolution, captureConflictFiles } from "../../lib/conflict-workspace";

const roots: string[] = [];
const identity = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "conflict-proof-")); roots.push(root);
  const repo = join(root, "repo"); mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: repo, env: identity, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  const write = (path: string, content: string | Buffer) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), content); };
  const commit = (message: string) => { git("add", "-A"); git("commit", "-qm", message); return git("rev-parse", "HEAD"); };
  git("init", "-q", "-b", "candidate"); git("config", "core.autocrlf", "false");
  return { root, repo, git, write, commit };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function conflict(path: string, tail = "") {
  const f = fixture();
  f.write(path, `base\n${tail}`); const base = f.commit("base"); f.git("branch", "openfloor-source-base", base);
  f.git("checkout", "-qb", "incoming"); f.write(path, `incoming\n${tail}`); const incoming = f.commit("incoming"); f.git("branch", "openfloor-source-result", incoming);
  f.git("checkout", "candidate"); f.write(path, `candidate\n${tail}`); f.commit("candidate");
  spawnSync("git", ["merge", "--no-commit", "incoming"], { cwd: f.repo, env: identity });
  return f;
}

describe("complete conflict workspace", () => {
  it("preserves spaces, Unicode, and a tail beyond the former preview limit with zero provider execution", () => {
    const path = "src/shared feature 日本語.ts";
    const tail = Array.from({ length: 4000 }, (_, i) => `untouched_${i}\n`).join("");
    const f = conflict(path, tail); const files = captureConflictFiles(f.repo);
    applyManualConflictResolution(f.repo, files, [{ path, hunkIndex: 0, choice: "both" }]);
    expect(readFileSync(join(f.repo, path), "utf8")).toBe(`candidate\nincoming\n${tail}`);
    expect(f.git("ls-files", "-u")).toBe("");
  });
  it("rejects changed content even when the number of hunks is unchanged, before writing", () => {
    const f = conflict("shared.txt"); const files = captureConflictFiles(f.repo);
    const changed = readFileSync(join(f.repo, "shared.txt"), "utf8").replace("candidate\n", "different\n");
    f.write("shared.txt", changed);
    expect(() => applyManualConflictResolution(f.repo, files, [{ path: "shared.txt", hunkIndex: 0, choice: "ours" }])).toThrow("content changed");
    expect(readFileSync(join(f.repo, "shared.txt"), "utf8")).toBe(changed);
  });
  it("requires complete, unique selections and never writes a partial submission", () => {
    const f = conflict("shared.txt"); const files = captureConflictFiles(f.repo); const before = readFileSync(join(f.repo, "shared.txt"));
    expect(() => applyManualConflictResolution(f.repo, files, [])).toThrow("every affected file");
    expect(() => applyManualConflictResolution(f.repo, files, [0, 0].map((hunkIndex) => ({ path: "shared.txt", hunkIndex, choice: "ours" })))).toThrow("Duplicate");
    expect(readFileSync(join(f.repo, "shared.txt"))).toEqual(before);
  });
  it("restores binary and non-UTF8 blobs byte for byte", () => {
    for (const bytes of [Buffer.from([0, 1, 255, 10]), Buffer.from([255, 254, 13, 10])]) {
      const f = fixture(); f.write("binary file", bytes); const base = f.commit("base"); f.git("branch", "openfloor-source-base", base);
      f.git("checkout", "-qb", "incoming"); const incoming = Buffer.concat([bytes, Buffer.from([42])]); f.write("binary file", incoming); f.commit("incoming"); f.git("branch", "openfloor-source-result");
      f.git("checkout", "candidate"); f.write("binary file", Buffer.concat([bytes, Buffer.from([43])])); f.commit("candidate");
      spawnSync("git", ["merge", "--no-commit", "incoming"], { cwd: f.repo, env: identity });
      const files = captureConflictFiles(f.repo);
      expect(files[0].wholeFileOnly).toBe(true);
      applyManualConflictResolution(f.repo, files, [{ path: "binary file", hunkIndex: -1, choice: "theirs" }]);
      expect(readFileSync(join(f.repo, "binary file"))).toEqual(incoming);
    }
  });
  it("supports modify/delete with an explicit complete-file deletion", () => {
    const f = fixture(); f.write("file.txt", "base\n"); const base = f.commit("base"); f.git("branch", "openfloor-source-base", base);
    f.git("checkout", "-qb", "incoming"); f.git("rm", "file.txt"); f.commit("delete"); f.git("branch", "openfloor-source-result");
    f.git("checkout", "candidate"); f.write("file.txt", "modified\n"); f.commit("modify");
    spawnSync("git", ["merge", "--no-commit", "incoming"], { cwd: f.repo, env: identity });
    const files = captureConflictFiles(f.repo); applyManualConflictResolution(f.repo, files, [{ path: "file.txt", hunkIndex: -1, choice: "theirs" }]);
    expect(f.git("ls-files", "-u")).toBe(""); expect(f.git("ls-files", "file.txt")).toBe("");
  });
  it("rejects path escape through a symlink ancestor", () => {
    const f = fixture(); f.write("baseline", "base"); f.commit("base"); f.git("branch", "openfloor-source-base"); f.git("branch", "openfloor-source-result");
    const outside = join(f.root, "outside"); mkdirSync(outside); symlinkSync(outside, join(f.repo, "escape"));
    expect(() => captureConflictFiles(f.repo, ["escape/missing/file"])).toThrow("escapes workspace");
  });
});

function integration(f: ReturnType<typeof fixture>, source: string, expected: string, run: string, resolution = false) {
  // Clone from a bare remote to exercise the same expected-ref push as GitHub.
  const remote = join(f.root, "remote.git");
  if (!readFileExists(remote)) execFileSync("git", ["clone", "--bare", f.repo, remote], { stdio: "pipe" });
  const resultPath = join(f.root, "result.json");
  execFileSync(process.execPath, [resolve("scripts/integrate-run.mjs")], { env: { ...identity,
    OPENFLOOR_INTEGRATION_ROOT: join(f.root, "trusted"), OPENFLOOR_GITHUB_TOKEN: "test-token", OPENFLOOR_REPOSITORY_URL: remote,
    OPENFLOOR_CANDIDATE_BRANCH: "candidate", OPENFLOOR_CANDIDATE_SHA: expected, OPENFLOOR_SOURCE_SHA: source,
    OPENFLOOR_RUN_BRANCH: "incoming", OPENFLOOR_RUN_SHA: run, OPENFLOOR_RESOLUTION: String(resolution), OPENFLOOR_RESULT_PATH: resultPath,
  }, stdio: "pipe" });
  return JSON.parse(readFileSync(resultPath, "utf8"));
}
function readFileExists(path: string) { try { return Boolean(execFileSync("git", ["--git-dir", path, "rev-parse", "--is-bare-repository"], { stdio: "pipe" })); } catch { return false; } }

describe("trusted integration", () => {
  it("preserves disjoint features and recovers idempotently after the push", () => {
    const f = fixture(); f.write("base", "base"); const base = f.commit("base");
    f.git("checkout", "-qb", "incoming"); f.write("new feature", "incoming"); const incoming = f.commit("incoming");
    f.git("checkout", "candidate"); f.write("team feature", "candidate"); const candidate = f.commit("team");
    const result = integration(f, base, candidate, incoming); expect(result.status).toBe("integrated");
    const remote = join(f.root, "remote.git");
    expect(execFileSync("git", ["--git-dir", remote, "show", "candidate:new feature"]).toString()).toBe("incoming");
    expect(execFileSync("git", ["--git-dir", remote, "show", "candidate:team feature"]).toString()).toBe("candidate");
    expect(integration(f, base, candidate, incoming)).toEqual(result);
  });
  it("routes a clean textual merge with contradictory intent through assessment", () => {
    const f = fixture(); f.write("settings", "allow=true\n\n\n\nlimit=5\n"); const base = f.commit("base");
    f.git("checkout", "-qb", "incoming"); f.write("settings", "allow=false\n\n\n\nlimit=5\n"); const incoming = f.commit("disable feature");
    f.git("checkout", "candidate"); f.write("settings", "allow=true\n\n\n\nlimit=10\n"); const candidate = f.commit("expand feature");
    const result = integration(f, base, candidate, incoming);
    expect(result).toMatchObject({ status: "conflicted", trigger: "overlap", paths: ["settings"] });
  });
  it("detects overlap across a rename and refuses a stale approved candidate", () => {
    const f = fixture(); f.write("old name", "base\n"); const base = f.commit("base");
    f.git("checkout", "-qb", "incoming"); f.write("old name", "incoming\n"); const incoming = f.commit("incoming");
    f.git("checkout", "candidate"); f.git("mv", "old name", "new name"); const candidate = f.commit("rename");
    expect(integration(f, base, candidate, incoming)).toMatchObject({ status: "conflicted", paths: ["new name", "old name"] });
    expect(integration(f, base, base, incoming, true).status).toBe("moved");
  });
});
