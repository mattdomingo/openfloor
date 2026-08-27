import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { githubGitAuthorization } from "./github-git-auth.mjs";

const required = ["OPENFLOOR_CLEANUP_ROOT", "OPENFLOOR_REPOSITORY_URL", "OPENFLOOR_GITHUB_TOKEN", "OPENFLOOR_BRANCHES"];
for (const name of required) if (!process.env[name]) throw new Error(`Missing cleanup setting: ${name}`);

const root = process.env.OPENFLOOR_CLEANUP_ROOT;
const branches = JSON.parse(process.env.OPENFLOOR_BRANCHES);
if (!Array.isArray(branches) || branches.length > 100) throw new Error("Invalid cleanup branch set");
for (const branch of branches) {
  if (!branch || typeof branch.name !== "string" || typeof branch.sha !== "string" ||
      !branch.name.startsWith("openfloor/") || !/^[a-z0-9/_-]+$/.test(branch.name) || !/^[0-9a-f]{40}$/.test(branch.sha)) {
    throw new Error("Invalid cleanup branch record");
  }
}

await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
git(["init", "-q"], root);
git(["remote", "add", "origin", process.env.OPENFLOOR_REPOSITORY_URL], root);
const authorization = githubGitAuthorization(process.env.OPENFLOOR_GITHUB_TOKEN);
const deleted = [];
const failed = [];
const ATTEMPTS = 3;
for (const branch of branches) {
  let lastError = "";
  let ok = false;
  for (let attempt = 1; attempt <= ATTEMPTS && !ok; attempt += 1) {
    const result = spawnSync("git", [
      "-c", "core.hooksPath=/dev/null",
      "-c", "credential.helper=",
      "-c", `http.extraHeader=${authorization}`,
      "push", `--force-with-lease=refs/heads/${branch.name}:${branch.sha}`,
      "origin", `:refs/heads/${branch.name}`,
    ], { cwd: root, maxBuffer: 1_000_000 });
    if (result.status === 0) {
      ok = true;
      break;
    }
    lastError = (result.stderr?.toString() || result.error?.message || `git exited ${result.status}`).trim().slice(0, 2000);
    // A lease rejection means the branch moved — retrying only wastes time,
    // the current SHA no longer matches what we verified before cleanup.
    if (/stale info|fetch first|non-fast-forward/i.test(lastError)) break;
    if (attempt < ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
  }
  if (ok) deleted.push(branch.name);
  else failed.push({ name: branch.name, error: lastError });
}
process.stdout.write(JSON.stringify({ deleted, failed }));

function git(args, cwd) {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", ...args], { cwd, maxBuffer: 1_000_000 });
  if (result.status !== 0) throw new Error(`Trusted cleanup Git operation failed (${args[0]})`);
}
