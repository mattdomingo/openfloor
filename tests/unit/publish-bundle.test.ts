import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { githubGitAuthorization } from "../../scripts/github-git-auth.mjs";

it("uses GitHub App installation tokens as the Git HTTPS password", () => {
  expect(githubGitAuthorization("ghs_example-token")).toBe(
    `Authorization: Basic ${Buffer.from("x-access-token:ghs_example-token").toString("base64")}`,
  );
  expect(() => githubGitAuthorization("bad\ntoken")).toThrow("Invalid GitHub installation token");
});

describe("trusted Git bundle publisher", () => {
  it("validates a single recorded change and publishes it on the exact candidate parent", () => {
    const root = mkdtempSync(join(tmpdir(), "openfloor-bundle-test-"));
    try {
      const remote = join(root, "remote.git");
      const source = join(root, "source");
      const agent = join(root, "agent");
      mkdirSync(join(source, "src"), { recursive: true });
      mkdirSync(agent, { recursive: true });
      git(["init", "-q", "--bare", remote]);
      git(["init", "-q", source]);
      git(["-C", source, "config", "user.name", "Test"]);
      git(["-C", source, "config", "user.email", "test@example.com"]);
      writeFileSync(join(source, "src/base.txt"), "base\n");
      git(["-C", source, "add", "-A"]);
      git(["-C", source, "commit", "-q", "-m", "base"], { GIT_AUTHOR_DATE: "2026-08-19T00:00:00Z", GIT_COMMITTER_DATE: "2026-08-19T00:00:00Z" });
      git(["-C", source, "branch", "-M", "candidate"]);
      git(["-C", source, "remote", "add", "origin", remote]);
      git(["-C", source, "push", "-q", "origin", "candidate"]);
      const candidateSha = git(["-C", source, "rev-parse", "HEAD"]).trim();
      const archive = execFileSync("git", ["-C", source, "archive", "HEAD"]);
      execFileSync("tar", ["-x", "-C", agent], { input: archive });
      git(["-C", agent, "init", "-q"]);
      git(["-C", agent, "add", "-A"]);
      const tree = git(["-C", agent, "write-tree"]).trim();
      const baseline = git(["-C", agent, "commit-tree", tree], {
        GIT_AUTHOR_NAME: "OpenFloor", GIT_AUTHOR_EMAIL: "runtime@opnflr.com",
        GIT_COMMITTER_NAME: "OpenFloor", GIT_COMMITTER_EMAIL: "runtime@opnflr.com",
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      }, "OpenFloor candidate baseline\n").trim();
      git(["-C", agent, "update-ref", "refs/heads/openfloor-base", baseline]);
      git(["-C", agent, "reset", "-q", "--hard", baseline]);
      writeFileSync(join(agent, "src/change.txt"), "change\n");
      git(["-C", agent, "add", "-A"]);
      git(["-C", agent, "-c", "user.name=OpenFloor", "-c", "user.email=runtime@opnflr.com", "commit", "-q", "-m", "run"]);
      const branch = "openfloor/session/run/test";
      git(["-C", agent, "update-ref", `refs/heads/${branch}`, "HEAD"]);
      const bundle = join(root, "result.bundle");
      git(["-C", agent, "bundle", "create", bundle, `refs/heads/${branch}`, "^refs/heads/openfloor-base"]);
      const result = join(root, "result.json");
      execFileSync("node", [resolve("scripts/publish-bundle.mjs")], { env: {
        ...process.env,
        OPENFLOOR_PUBLISH_ROOT: join(root, "publisher"), OPENFLOOR_BUNDLE_PATH: bundle,
        OPENFLOOR_REPOSITORY_URL: remote, OPENFLOOR_GITHUB_TOKEN: "test",
        OPENFLOOR_CANDIDATE_BRANCH: "candidate", OPENFLOOR_CANDIDATE_SHA: candidateSha,
        OPENFLOOR_RUN_BRANCH: branch, OPENFLOOR_EXPECTED_PATHS: JSON.stringify(["src/change.txt"]),
        OPENFLOOR_RESULT_PATH: result, OPENFLOOR_COMMIT_DATE: "2026-08-19T01:00:00Z",
        OPENFLOOR_RUN_ID: "12345678-1234-1234-1234-123456789abc",
      } });
      const published = JSON.parse(readFileSync(result, "utf8")) as { publishedCommit: string; paths: string[] };
      expect(published.paths).toEqual(["src/change.txt"]);
      expect(git(["--git-dir", remote, "rev-parse", `refs/heads/${branch}`]).trim()).toBe(published.publishedCommit);
      expect(git(["--git-dir", remote, "show", "-s", "--format=%P", published.publishedCommit]).trim()).toBe(candidateSha);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});

function git(args: string[], extraEnv: Record<string, string> = {}, input?: string) {
  return execFileSync("git", args, { encoding: "utf8", env: { ...process.env, ...extraEnv }, input });
}
