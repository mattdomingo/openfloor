import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FILE_REMOVAL_PREPARE_COMMAND } from "@/lib/file-removal-git";

const temporaryRoots: string[] = [];

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
}

function existsInCommit(directory: string, commit: string, path: string): boolean {
  return spawnSync("git", ["cat-file", "-e", `${commit}:${path}`], { cwd: directory, stdio: "ignore" }).status === 0;
}

function prepareFixture() {
  const root = mkdtempSync(join(tmpdir(), "openfloor-file-removal-"));
  temporaryRoots.push(root);
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  const workspace = join(root, "workspace-repository");
  mkdirSync(join(source, "src"), { recursive: true });
  git(source, "init", "-q");
  git(source, "config", "user.name", "Test");
  git(source, "config", "user.email", "test@example.com");
  writeFileSync(join(source, "src", "modified.ts"), "export const value = 'base';\n");
  writeFileSync(join(source, "src", "deleted.ts"), "export const deleted = false;\n");
  writeFileSync(join(source, "src", "old-name.ts"), "export const renamed = false;\n");
  writeFileSync(join(source, "src", "untouched.ts"), "export const untouched = false;\n");
  git(source, "add", ".");
  git(source, "commit", "-q", "-m", "base");
  const baseSha = git(source, "rev-parse", "HEAD");
  writeFileSync(join(source, "src", "modified.ts"), "export const value = 'candidate';\n");
  writeFileSync(join(source, "src", "added.ts"), "export const added = true;\n");
  writeFileSync(join(source, "src", "untouched.ts"), "export const untouched = true;\n");
  git(source, "rm", "-q", "src/deleted.ts");
  git(source, "mv", "src/old-name.ts", "src/new-name.ts");
  git(source, "add", ".");
  git(source, "commit", "-q", "-m", "candidate");
  const candidateSha = git(source, "rev-parse", "HEAD");
  git(root, "init", "-q", "--bare", remote);
  git(source, "remote", "add", "origin", remote);
  git(source, "push", "-q", "origin", `${candidateSha}:refs/heads/candidate`);
  return { remote, workspace, baseSha, candidateSha };
}

function removePath(fixture: ReturnType<typeof prepareFixture>, path: string, previousPath = ""): string {
  const command = FILE_REMOVAL_PREPARE_COMMAND.replaceAll("/workspace/repository", '"$OPENFLOOR_TEST_REPOSITORY"');
  return execFileSync("sh", ["-c", command], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENFLOOR_TEST_REPOSITORY: fixture.workspace,
      OPENFLOOR_REPOSITORY_URL: fixture.remote,
      OPENFLOOR_GIT_AUTHORIZATION: "",
      OPENFLOOR_EXPECTED_SHA: fixture.candidateSha,
      OPENFLOOR_BASE_SHA: fixture.baseSha,
      OPENFLOOR_FILE_PATH: path,
      OPENFLOOR_PREVIOUS_FILE_PATH: previousPath,
      OPENFLOOR_COMMIT_DATE: "2026-09-05T12:00:00.000Z",
      OPENFLOOR_COMMIT_MESSAGE: `Remove reviewed changes from ${path}`,
    },
  }).trim();
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("candidate file removal git preparation", () => {
  it("restores modified and deleted paths, deletes additions, and reverses renames", () => {
    const cases = [
      { path: "src/modified.ts", expected: "export const value = 'base';\n" },
      { path: "src/deleted.ts", expected: "export const deleted = false;\n" },
      { path: "src/added.ts", absent: "src/added.ts" },
      { path: "src/new-name.ts", previousPath: "src/old-name.ts", absent: "src/new-name.ts", expectedPath: "src/old-name.ts", expected: "export const renamed = false;\n" },
    ];
    for (const item of cases) {
      const fixture = prepareFixture();
      const commit = removePath(fixture, item.path, item.previousPath);
      expect(commit).toMatch(/^[0-9a-f]{40}$/);
      if (item.absent) expect(existsInCommit(fixture.workspace, commit, item.absent)).toBe(false);
      if (item.expected) expect(git(fixture.workspace, "show", `${commit}:${item.expectedPath ?? item.path}`) + "\n").toBe(item.expected);
      expect(git(fixture.workspace, "show", `${commit}:src/untouched.ts`) + "\n").toBe("export const untouched = true;\n");
    }
  });

  it("rejects a selected path that already matches the base", () => {
    const fixture = prepareFixture();
    expect(() => removePath(fixture, "src/missing.ts")).toThrow();
  });
});
