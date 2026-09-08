import { commitAuthors } from "./commit-authors.mjs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { githubGitAuthorization } from "./github-git-auth.mjs";

const required = ["OPENFLOOR_PUBLISH_ROOT", "OPENFLOOR_BUNDLE_PATH", "OPENFLOOR_REPOSITORY_URL", "OPENFLOOR_GITHUB_TOKEN", "OPENFLOOR_CANDIDATE_BRANCH", "OPENFLOOR_CANDIDATE_SHA", "OPENFLOOR_RUN_BRANCH", "OPENFLOOR_EXPECTED_PATHS", "OPENFLOOR_RESULT_PATH", "OPENFLOOR_COMMIT_DATE", "OPENFLOOR_RUN_ID"];
for (const name of required) if (!process.env[name]) throw new Error(`Missing publisher setting: ${name}`);

const root = process.env.OPENFLOOR_PUBLISH_ROOT;
const repository = `${root}/repository`;
const bundle = process.env.OPENFLOOR_BUNDLE_PATH;
const token = process.env.OPENFLOOR_GITHUB_TOKEN;
const candidateBranch = process.env.OPENFLOOR_CANDIDATE_BRANCH;
const candidateSha = process.env.OPENFLOOR_CANDIDATE_SHA;
const runBranch = process.env.OPENFLOOR_RUN_BRANCH;
const resultPath = process.env.OPENFLOOR_RESULT_PATH;
const expectedPaths = JSON.parse(process.env.OPENFLOOR_EXPECTED_PATHS);
const auth = githubGitAuthorization(token);
const authors = commitAuthors(process.env.OPENFLOOR_COMMIT_AUTHORS);
const fixedIdentity = {
  GIT_AUTHOR_NAME: authors[0]?.name ?? "openfloor agent",
  GIT_AUTHOR_EMAIL: authors[0]?.email ?? "runtime@opnflr.com",
  GIT_COMMITTER_NAME: "openfloor agent",
  GIT_COMMITTER_EMAIL: "runtime@opnflr.com",
};
const baselineIdentity = {
  GIT_AUTHOR_NAME: "openfloor",
  GIT_AUTHOR_EMAIL: "runtime@opnflr.com",
  GIT_COMMITTER_NAME: "openfloor",
  GIT_COMMITTER_EMAIL: "runtime@opnflr.com",
};

await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
// blob:none keeps the full commit graph (the ancestry check and tree reads
// below need it — no --depth) while skipping every historical blob; the bundle
// fetch supplies new objects locally, but thin-pack bases and tree inspection
// can still fetch promised blobs. Every Git invocation carries transient
// transport credentials so those child fetches authenticate too.
git(["clone", "--filter=blob:none", "--no-checkout", "--single-branch", "--branch", candidateBranch, process.env.OPENFLOOR_REPOSITORY_URL, repository], root);
const observedCandidate = git(["rev-parse", `refs/remotes/origin/${candidateBranch}`], repository).trim();
try {
  git(["merge-base", "--is-ancestor", candidateSha, observedCandidate], repository);
} catch {
  throw new Error("Pinned candidate is no longer in the candidate branch ancestry");
}

const candidateTree = git(["rev-parse", `${candidateSha}^{tree}`], repository).trim();
const baseline = git(["commit-tree", candidateTree], repository, {
  ...baselineIdentity,
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
}, "openfloor candidate baseline\n").trim();
git(["update-ref", "refs/openfloor/baseline", baseline], repository);
git(["bundle", "verify", bundle], repository);
const expectedRef = `refs/heads/${runBranch}`;
const heads = git(["bundle", "list-heads", bundle], repository).trim().split("\n").filter(Boolean);
if (heads.length !== 1 || !heads[0].endsWith(` ${expectedRef}`)) throw new Error("Bundle contains an unexpected reference set");
git(["fetch", "--no-tags", bundle, `${expectedRef}:refs/openfloor/result`], repository);
const localCommit = git(["rev-parse", "refs/openfloor/result"], repository).trim();
const parents = git(["show", "-s", "--format=%P", localCommit], repository).trim().split(/\s+/).filter(Boolean);
if (parents.length !== 1 || parents[0] !== baseline) throw new Error("Bundle result does not have the verified baseline as its only parent");
const commits = git(["rev-list", "--count", localCommit, `^${baseline}`], repository).trim();
if (commits !== "1") throw new Error("Bundle must contain exactly one result commit");

const observedPaths = splitNul(gitBuffer(["diff", "--name-only", "-z", baseline, localCommit], repository)).sort();
const normalizedExpected = [...expectedPaths].sort();
if (JSON.stringify(observedPaths) !== JSON.stringify(normalizedExpected)) throw new Error("Bundle file set does not match the recorded run files");
if (observedPaths.some((path) => path === ".github/workflows" || path.startsWith(".github/workflows/"))) throw new Error("Workflow-file changes are not allowed");

const objectIds = git(["rev-list", "--objects", localCommit, `^${baseline}`], repository).split("\n").filter(Boolean).map((line) => line.split(" ", 1)[0]);
if (objectIds.length > 5_000) throw new Error("Bundle contains too many Git objects");
// One batch-check invocation instead of one git process per object.
const sizeLines = git(["cat-file", "--batch-check=%(objectname) %(objectsize)"], repository, {}, objectIds.join("\n")).split("\n").filter(Boolean);
if (sizeLines.length !== objectIds.length) throw new Error("Bundle object inventory is incomplete");
let totalBytes = 0;
for (const line of sizeLines) {
  const size = Number(line.split(" ")[1]);
  if (!Number.isSafeInteger(size) || size > 5 * 1024 * 1024) throw new Error("Bundle contains an oversized Git object");
  totalBytes += size;
  if (totalBytes > 25 * 1024 * 1024) throw new Error("Bundle Git objects exceed the publication limit");
}

const resultTree = git(["rev-parse", `${localCommit}^{tree}`], repository).trim();
const message = process.env.OPENFLOOR_COMMIT_MESSAGE || `openfloor run ${process.env.OPENFLOOR_RUN_ID.slice(0, 8)}\n`;
const coauthors = authors.slice(1).map((author) => `Co-authored-by: ${author.name} <${author.email}>`).join("\n");
const publishedCommit = git(["commit-tree", resultTree, "-p", candidateSha], repository, {
  ...fixedIdentity,
  GIT_AUTHOR_DATE: process.env.OPENFLOOR_COMMIT_DATE,
  GIT_COMMITTER_DATE: process.env.OPENFLOOR_COMMIT_DATE,
}, coauthors ? `${message.trimEnd()}\n${coauthors}\n` : message).trim();
const remote = git(["ls-remote", "--heads", "origin", expectedRef], repository).trim();
if (remote) {
  if (remote.split(/\s+/, 1)[0] !== publishedCommit) throw new Error("Run branch already exists at an unexpected commit");
} else {
  git(["push", "origin", `${publishedCommit}:${expectedRef}`], repository);
}
await writeFile(resultPath, JSON.stringify({ localCommit, publishedCommit, paths: observedPaths }), "utf8");

function git(args, cwd, extraEnv = {}, input) {
  return gitResult(args, cwd, extraEnv, input).stdout.toString("utf8");
}

function gitBuffer(args, cwd) {
  return gitResult(args, cwd).stdout;
}

function gitResult(args, cwd, extraEnv = {}, input) {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c", `http.extraHeader=${auth}`, ...args], {
    cwd,
    env: { ...process.env, ...extraEnv },
    input,
    maxBuffer: 30 * 1024 * 1024,
  });
  if (result.status !== 0) {
    // Remote failures are retained in run history. Never retain either the
    // installation token or its reversible HTTP Basic representation.
    const detail = (result.stderr?.toString("utf8") || result.error?.message || `git exited ${result.status}`)
      .replaceAll(token, "[REDACTED]")
      .replaceAll(auth.slice("Authorization: Basic ".length), "[REDACTED]");
    throw new Error(`Trusted Git operation failed (${args[0]}): ${detail.slice(-1_000)}`);
  }
  return result;
}

function splitNul(value) {
  return value.toString("utf8").split("\0").filter(Boolean);
}
