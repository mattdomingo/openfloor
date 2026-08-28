import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("deletes only branches that still match their recorded SHA", () => {
  const root = mkdtempSync(join(tmpdir(), "openfloor-cleanup-test-"));
  try {
    const remote = join(root, "remote.git");
    const source = join(root, "source");
    mkdirSync(source);
    git(["init", "-q", "--bare", remote]);
    git(["init", "-q", source]);
    git(["-C", source, "config", "user.name", "Test"]);
    git(["-C", source, "config", "user.email", "test@example.com"]);
    writeFileSync(join(source, "file.txt"), "one\n");
    git(["-C", source, "add", "-A"]);
    git(["-C", source, "commit", "-q", "-m", "one"]);
    const firstSha = git(["-C", source, "rev-parse", "HEAD"]).trim();
    git(["-C", source, "remote", "add", "origin", remote]);
    git(["-C", source, "push", "-q", "origin", `HEAD:refs/heads/openfloor/session/run/one`, `HEAD:refs/heads/openfloor/session/run/two`]);
    writeFileSync(join(source, "file.txt"), "two\n");
    git(["-C", source, "commit", "-qam", "two"]);
    git(["-C", source, "push", "-q", "origin", `HEAD:refs/heads/openfloor/session/run/two`]);
    const result = JSON.parse(execFileSync("node", [resolve("scripts/cleanup-branches.mjs")], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENFLOOR_CLEANUP_ROOT: join(root, "cleanup"),
        OPENFLOOR_REPOSITORY_URL: remote,
        OPENFLOOR_GITHUB_TOKEN: "test",
        OPENFLOOR_BRANCHES: JSON.stringify([
          { name: "openfloor/session/run/one", sha: firstSha },
          { name: "openfloor/session/run/two", sha: firstSha },
        ]),
      },
    })) as { deleted: string[]; failed: Array<{ name: string; error: string }> };
    expect(result.deleted).toEqual(["openfloor/session/run/one"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].name).toBe("openfloor/session/run/two");
    expect(result.failed[0].error.length).toBeGreaterThan(0);
    expect(() => git(["--git-dir", remote, "rev-parse", "refs/heads/openfloor/session/run/one"])).toThrow();
    expect(git(["--git-dir", remote, "rev-parse", "refs/heads/openfloor/session/run/two"]).trim()).not.toBe(firstSha);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 45_000);

function git(args: string[]) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
