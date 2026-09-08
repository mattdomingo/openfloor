import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { promisify } from "node:util";
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
  it.each(["local", "authenticated HTTP", "engineer authors"])("publishes on the pinned parent after the candidate advances over %s", async (transport) => {
    const root = mkdtempSync(join(tmpdir(), "openfloor-bundle-test-"));
    let server: Awaited<ReturnType<typeof authenticatedGitServer>> | undefined;
    try {
      const remote = join(root, "remote.git");
      const source = join(root, "source");
      const agent = join(root, "agent");
      mkdirSync(join(source, "src"), { recursive: true });
      mkdirSync(agent, { recursive: true });
      git(["init", "-q", "--bare", remote]);
      git(["--git-dir", remote, "config", "uploadpack.allowFilter", "true"]);
      git(["--git-dir", remote, "config", "uploadpack.allowAnySHA1InWant", "true"]);
      git(["--git-dir", remote, "config", "http.receivepack", "true"]);
      git(["init", "-q", source]);
      git(["-C", source, "config", "user.name", "Test"]);
      git(["-C", source, "config", "user.email", "test@example.com"]);
      writeFileSync(join(source, "src/base.txt"), "Base contents long enough to delta reliably.\n".repeat(500));
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
        GIT_AUTHOR_NAME: "openfloor", GIT_AUTHOR_EMAIL: "runtime@opnflr.com",
        GIT_COMMITTER_NAME: "openfloor", GIT_COMMITTER_EMAIL: "runtime@opnflr.com",
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      }, "openfloor candidate baseline\n").trim();
      git(["-C", agent, "update-ref", "refs/heads/openfloor-base", baseline]);
      git(["-C", agent, "reset", "-q", "--hard", baseline]);
      // Changing an existing large blob makes the thin bundle depend on a
      // promised baseline blob, reproducing the unauthenticated lazy fetch.
      writeFileSync(join(agent, "src/base.txt"), readFileSync(join(agent, "src/base.txt"), "utf8") + "change\n");
      git(["-C", agent, "add", "-A"]);
      git(["-C", agent, "-c", "user.name=openfloor", "-c", "user.email=runtime@opnflr.com", "commit", "-q", "-m", "run"]);
      const branch = "openfloor/session/run/test";
      git(["-C", agent, "update-ref", `refs/heads/${branch}`, "HEAD"]);
      const bundle = join(root, "result.bundle");
      git(["-C", agent, "bundle", "create", bundle, `refs/heads/${branch}`, "^refs/heads/openfloor-base"]);
      writeFileSync(join(source, "src/later.txt"), "integrated while this run was checking\n");
      git(["-C", source, "add", "-A"]);
      git(["-C", source, "commit", "-q", "-m", "advance candidate"], {
        GIT_AUTHOR_DATE: "2026-08-19T00:30:00Z",
        GIT_COMMITTER_DATE: "2026-08-19T00:30:00Z",
      });
      git(["-C", source, "push", "-q", "origin", "candidate"]);
      expect(git(["-C", source, "rev-parse", "HEAD"]).trim()).not.toBe(candidateSha);
      const result = join(root, "result.json");
      if (transport === "authenticated HTTP") server = await authenticatedGitServer(root, "test");
      const publishEnv = {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        OPENFLOOR_COMMIT_AUTHORS: transport === "engineer authors" ? JSON.stringify([{ id: "123", login: "Ada" }, { id: "456", login: "Grace" }]) : "null",
        OPENFLOOR_PUBLISH_ROOT: join(root, "publisher"), OPENFLOOR_BUNDLE_PATH: bundle,
        OPENFLOOR_REPOSITORY_URL: server?.url ?? remote, OPENFLOOR_GITHUB_TOKEN: "test",
        OPENFLOOR_CANDIDATE_BRANCH: "candidate", OPENFLOOR_CANDIDATE_SHA: candidateSha,
        OPENFLOOR_RUN_BRANCH: branch, OPENFLOOR_EXPECTED_PATHS: JSON.stringify(["src/base.txt"]),
        OPENFLOOR_RESULT_PATH: result, OPENFLOOR_COMMIT_DATE: "2026-08-19T01:00:00Z",
        OPENFLOOR_RUN_ID: "12345678-1234-1234-1234-123456789abc",
        OPENFLOOR_COMMIT_MESSAGE: "Update base content\n\nOpenfloor-Run: 12345678-1234-1234-1234-123456789abc\n",
      };
      await promisify(execFile)("node", [resolve("scripts/publish-bundle.mjs")], { env: publishEnv });
      const published = JSON.parse(readFileSync(result, "utf8")) as { publishedCommit: string; paths: string[] };
      expect(published.paths).toEqual(["src/base.txt"]);
      const trailers = transport === "engineer authors" ? "\nCo-authored-by: Grace <456+Grace@users.noreply.github.com>" : "";
      expect(git(["--git-dir", remote, "show", "-s", "--format=%B", published.publishedCommit]).trim()).toBe(`Update base content\n\nOpenfloor-Run: 12345678-1234-1234-1234-123456789abc${trailers}`);
      expect(git(["--git-dir", remote, "show", "-s", "--format=%an <%ae>|%cn <%ce>", published.publishedCommit]).trim()).toBe(`${transport === "engineer authors" ? "Ada <123+Ada@users.noreply.github.com>" : "openfloor agent <runtime@opnflr.com>"}|openfloor agent <runtime@opnflr.com>`);
      await promisify(execFile)("node", [resolve("scripts/publish-bundle.mjs")], { env: publishEnv });
      expect(JSON.parse(readFileSync(result, "utf8")).publishedCommit).toBe(published.publishedCommit);
      expect(git(["--git-dir", remote, "show", `${published.publishedCommit}:src/base.txt`])).toBe(git(["-C", agent, "show", "HEAD:src/base.txt"]));
      await expect(promisify(execFile)("node", [resolve("scripts/publish-bundle.mjs")], { env: { ...publishEnv, OPENFLOOR_COMMIT_AUTHORS: JSON.stringify([{ id: "123", login: "Ada\nCo-authored-by: Forged" }]) } })).rejects.toThrow("Invalid commit authors");
      expect(git(["--git-dir", remote, "rev-parse", `refs/heads/${branch}`]).trim()).toBe(published.publishedCommit);
      expect(git(["--git-dir", remote, "rev-parse", `refs/heads/${branch}`]).trim()).toBe(published.publishedCommit);
      expect(git(["--git-dir", remote, "show", "-s", "--format=%P", published.publishedCommit]).trim()).toBe(candidateSha);
      if (server) {
        expect(server.requests.filter((request) => request.path.endsWith("/git-upload-pack")).length).toBeGreaterThan(1);
        expect(server.requests.every((request) => request.authorized)).toBe(true);
        const config = readFileSync(join(root, "publisher/repository/.git/config"), "utf8");
        expect(config).toContain("promisor = true");
        expect(config).not.toMatch(/extraheader|Authorization|eC1hY2Nlc3MtdG9rZW46dGVzdA==/i);
      }
    } finally {
      await server?.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);
});

function git(args: string[], extraEnv: Record<string, string> = {}, input?: string) {
  return execFileSync("git", args, { encoding: "utf8", env: { ...process.env, ...extraEnv }, input });
}


async function authenticatedGitServer(root: string, token: string) {
  const requests: Array<{ path: string; authorized: boolean }> = [];
  const authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    const authorized = request.headers.authorization === authorization;
    requests.push({ path: url.pathname, authorized });
    if (!authorized) {
      response.writeHead(401, { "www-authenticate": 'Basic realm="git"' });
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const output = execFileSync("git", ["http-backend"], {
      env: {
        ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method!, REMOTE_USER: "test",
        CONTENT_TYPE: String(request.headers["content-type"] ?? ""), CONTENT_LENGTH: String(body.length),
      },
      input: body,
    });
    const separator = output.toString().indexOf("\r\n\r\n");
    const headers: Record<string, string> = {};
    for (const line of output.subarray(0, separator).toString().split("\r\n")) {
      const colon = line.indexOf(":");
      headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
    }
    const status = Number(headers.status?.split(" ")[0] ?? 200);
    delete headers.status;
    response.writeHead(status, headers);
    response.end(output.subarray(separator + 4));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Git fixture did not listen");
  return {
    url: `http://127.0.0.1:${address.port}/remote.git`, requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
