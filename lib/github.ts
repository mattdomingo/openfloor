import { SignJWT, importPKCS8 } from "jose";
import { BASE_PATH } from "@/components/basePath";
import type { GitHubRepositoryOption } from "@/lib/session-types";

export type GitHubTestRepository = GitHubRepositoryOption & {
  branches: string[];
  branchShas?: Record<string, string>;
  // Path -> UTF-8 contents, served by listRepositoryTree/getRepositoryFileContent
  // in test-adapter mode. Directories are inferred from path segments.
  files?: Record<string, string>;
};

export type RepositoryTreeEntry = { path: string; type: "file" | "dir"; size: number | null; sha: string };
export type RepositoryTree = { ref: string; sha: string; entries: RepositoryTreeEntry[]; truncated: boolean };
export type RepositoryFileContent =
  | { path: string; encoding: "text"; text: string; size: number; truncated: boolean }
  | { path: string; encoding: "binary" | "too_large"; size: number };

export type GitHubPullRequestReview = {
  number: number;
  nodeId: string;
  url: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  mergeable: boolean | null;
  mergeableState: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  mergeCommitSha: string | null;
  checksPassing: boolean;
  files: Array<{ path: string; additions: number; deletions: number; changeKind: "add" | "update" | "delete"; patchPreview: string }>;
  checks: Array<{ sourceId: string; name: string; detail: string | null; state: "passed" | "waiting" | "failed" }>;
};

// Feedback facts for the candidate PR: what lib/candidate-feedback.ts turns
// into nudges. One GraphQL query, re-fetched after every qualifying webhook
// (payloads are per-check/per-comment and lack thread resolution, bot typing,
// and the full check rollup).
export type GitHubPullRequestFeedback = {
  number: number;
  nodeId: string;
  url: string;
  state: "open" | "closed";
  merged: boolean;
  headSha: string;
  reviewDecision: "approved" | "changes_requested" | "review_required" | null;
  failedChecks: Array<{ name: string; status: string; url: string | null }>;
  unresolvedThreads: Array<{ threadId: string; comments: Array<{ id: string; author: string; body: string; path: string | null; line: number | null; url: string }> }>;
  changesRequested: Array<{ id: string; author: string; body: string; url: string }>;
};

export type GitHubAppConfig = {
  appId: string;
  privateKey: string;
  slug: string;
  /** The GitHub App's OAuth client id — public, used only for the device
      flow. Empty when GITHUB_APP_CLIENT_ID is not configured. */
  clientId?: string;
  /** The App's OAuth client secret, for exchanging the one-time `code` the
      install redirect carries when "Request user authorization during
      installation" is enabled — so the callback can verify the installer's
      repo scope in one step. Empty when GITHUB_CLIENT_SECRET is not set;
      the callback then links with an empty scope and the device flow
      verifies instead. */
  clientSecret?: string;
  stateSecret: string;
  webhookSecret: string;
  testData: { installationId: string; accountLogin?: string; accountType?: string; repositories: GitHubTestRepository[] } | null;
};

const API_ROOT = "https://api.github.com";
const API_VERSION = "2026-03-10";
const testRefs = new Map<string, string>();
const testMergeConflicts = new Set<string>();
type TestPullRequest = {
  number: number; nodeId: string; url: string; state: "open" | "closed"; draft: boolean; merged: boolean;
  headRef: string; baseRef: string; mergeCommitSha: string | null;
};
const testPullRequests = new Map<string, TestPullRequest>();
const testPullRequestFeedback = new Map<string, Partial<GitHubPullRequestFeedback>>();

/** Test-adapter seam for getPullRequestFeedback: facts for `repositoryId` PR
    `number`, merged over an empty observation (open, no failures, no threads). */
export function setTestPullRequestFeedback(repositoryId: string, number: number, feedback: Partial<GitHubPullRequestFeedback>): void {
  testPullRequestFeedback.set(`${repositoryId}:${number}`, feedback);
}

/** The repos inside one installation that a member's own user token can
    reach — GitHub already intersects installation grants with user
    permissions here. Null (rather than a guess) on any error. Used by both
    connect paths: the device flow and the install-redirect code exchange. */
export async function listUserInstallationRepositoryIds(
  accessToken: string,
  installationId: string,
): Promise<string[] | null> {
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${accessToken}`,
    "user-agent": "openfloor",
  };
  const ids: string[] = [];
  let page = 1;
  while (true) {
    const response = await fetch(
      `${API_ROOT}/user/installations/${encodeURIComponent(installationId)}/repositories?per_page=100&page=${page}`,
      { headers },
    );
    if (!response.ok) return null;
    const body = await response.json().catch(() => null) as { repositories?: Array<{ id?: number }> } | null;
    if (!body) return null;
    const repositories = body.repositories ?? [];
    ids.push(...repositories.filter((repository) => repository.id != null).map((repository) => String(repository.id)));
    if (repositories.length < 100) return ids;
    if (page >= 10) return null;
    page += 1;
  }
}

export function githubInstallationUrl(config: GitHubAppConfig, state: string): string {
  if (config.testData) {
    const query = new URLSearchParams({
      installation_id: config.testData.installationId,
      setup_action: "install",
      state,
    });
    return `${BASE_PATH}/api/github/callback?${query}`;
  }
  const url = new URL(`https://github.com/apps/${encodeURIComponent(config.slug)}/installations/new`);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function getInstallationAccount(
  config: GitHubAppConfig,
  installationId: string,
): Promise<{ login: string; type: string }> {
  if (config.testData) {
    if (installationId !== config.testData.installationId) throw new GitHubApiError("Installation is not available", 404);
    return { login: config.testData.accountLogin ?? "openfloor-test", type: config.testData.accountType ?? "Organization" };
  }
  const token = await createGitHubAppJwt(config);
  const response = await githubFetch(`${API_ROOT}/app/installations/${encodeURIComponent(installationId)}`, token);
  const body = await response.json() as { account?: { login?: string; type?: string } };
  if (!body.account?.login) throw new GitHubApiError("GitHub did not return the installation account", 502);
  return { login: body.account.login, type: body.account.type ?? "Account" };
}

export async function listInstallationRepositories(
  config: GitHubAppConfig,
  installationId: string,
): Promise<GitHubRepositoryOption[]> {
  if (config.testData) {
    if (installationId !== config.testData.installationId) throw new GitHubApiError("Installation is not available", 404);
    return config.testData.repositories.map((repository) => ({
      id: repository.id,
      nodeId: repository.nodeId,
      owner: repository.owner,
      name: repository.name,
      fullName: repository.fullName,
      private: repository.private,
      defaultBranch: repository.defaultBranch,
    }));
  }
  const token = await createInstallationToken(config, installationId);
  const repositories: GitHubRepositoryOption[] = [];
  let page = 1;
  while (true) {
    const response = await githubFetch(`${API_ROOT}/installation/repositories?per_page=100&page=${page}`, token);
    const body = await response.json() as { repositories?: GitHubRepositoryRecord[] };
    const pageRepositories = body.repositories ?? [];
    repositories.push(...pageRepositories.map(mapRepository));
    if (pageRepositories.length < 100) break;
    page += 1;
    if (page > 10) throw new GitHubApiError("Installation has too many repositories to configure safely", 422);
  }
  return repositories;
}

export async function listRepositoryBranches(
  config: GitHubAppConfig,
  installationId: string,
  repository: GitHubRepositoryOption,
): Promise<string[]> {
  if (config.testData) {
    const match = config.testData.repositories.find((item) => item.id === repository.id);
    if (!match || installationId !== config.testData.installationId) throw new GitHubApiError("Repository is not available", 404);
    return [...match.branches];
  }
  const token = await createInstallationToken(config, installationId, repository.id);
  const branches: string[] = [];
  let page = 1;
  while (true) {
    const response = await githubFetch(
      `${API_ROOT}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/branches?per_page=100&page=${page}`,
      token,
    );
    const body = await response.json() as Array<{ name?: string }>;
    const names = body.flatMap((branch) => typeof branch.name === "string" ? [branch.name] : []);
    branches.push(...names);
    if (names.length < 100) break;
    page += 1;
    if (page > 10) throw new GitHubApiError("Repository has too many branches to configure safely", 422);
  }
  return branches;
}

export async function getInstallationRepository(
  config: GitHubAppConfig,
  installationId: string,
  repositoryId: string,
): Promise<GitHubRepositoryOption> {
  const repository = (await listInstallationRepositories(config, installationId)).find((item) => item.id === repositoryId);
  if (!repository) throw new GitHubApiError("Repository is not available", 404);
  return repository;
}

export async function getRepositoryRefSha(
  config: GitHubAppConfig,
  installationId: string,
  repository: GitHubRepositoryOption,
  branch: string,
): Promise<string> {
  if (config.testData) {
    const match = config.testData.repositories.find((item) => item.id === repository.id);
    if (!match || installationId !== config.testData.installationId) throw new GitHubApiError("Repository is not available", 404);
    const key = `${installationId}:${repository.id}:${branch}`;
    const sha = testRefs.get(key) ?? match.branchShas?.[branch] ?? (match.branches.includes(branch) ? "1".repeat(40) : null);
    if (!sha) throw new GitHubApiError("Branch is not available", 404);
    return sha;
  }
  const token = await createInstallationToken(config, installationId, repository.id);
  const response = await githubFetch(
    `${API_ROOT}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`,
    token,
  );
  const body = await response.json() as { object?: { sha?: string } };
  if (!body.object?.sha) throw new GitHubApiError("GitHub did not return a branch SHA", 502);
  return body.object.sha;
}

export async function createRepositoryBranch(
  config: GitHubAppConfig,
  installationId: string,
  repository: GitHubRepositoryOption,
  branch: string,
  sha: string,
): Promise<string> {
  if (!branch.startsWith("openfloor/") || !/^[a-z0-9/_-]+$/.test(branch)) {
    throw new GitHubApiError("openfloor generated an invalid branch", 500);
  }
  if (config.testData) {
    const match = config.testData.repositories.find((item) => item.id === repository.id);
    if (!match || installationId !== config.testData.installationId) throw new GitHubApiError("Repository is not available", 404);
    const key = `${installationId}:${repository.id}:${branch}`;
    if (testRefs.has(key)) throw new GitHubApiError("Reference already exists", 422);
    testRefs.set(key, sha);
    return sha;
  }
  const token = await createInstallationToken(config, installationId, repository.id);
  const response = await fetch(
    `${API_ROOT}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/refs`,
    {
      method: "POST",
      headers: { ...githubHeaders(token), "content-type": "application/json" },
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
    },
  );
  if (!response.ok) throw await githubError(response);
  const body = await response.json() as { object?: { sha?: string } };
  return body.object?.sha ?? sha;
}

/** Test-adapter counterpart of the rollback workflow's expected-SHA push. */
export async function updateTestRepositoryBranchIfMatches(
  config: GitHubAppConfig,
  installationId: string,
  repository: GitHubRepositoryOption,
  branch: string,
  expectedSha: string,
  nextSha: string,
): Promise<boolean> {
  if (!config.testData) throw new GitHubApiError("Test repository updates require test adapter data", 500);
  if (!branch.startsWith("openfloor/") || !/^[a-z0-9/_-]+$/.test(branch)) {
    throw new GitHubApiError("openfloor generated an invalid branch", 500);
  }
  const match = config.testData.repositories.find((item) => item.id === repository.id);
  if (!match || installationId !== config.testData.installationId) throw new GitHubApiError("Repository is not available", 404);
  const key = `${installationId}:${repository.id}:${branch}`;
  const current = testRefs.get(key) ?? match.branchShas?.[branch] ?? (match.branches.includes(branch) ? "1".repeat(40) : null);
  if (current !== expectedSha) return false;
  testRefs.set(key, nextSha);
  return true;
}

export function setTestRepositoryMergeConflict(repositoryId: string, headSha: string): void {
  testMergeConflicts.add(`${repositoryId}:${headSha}`);
}

export async function mergeRepositoryBranch(
  config: GitHubAppConfig,
  installationId: string,
  repository: GitHubRepositoryOption,
  baseBranch: string,
  headSha: string,
  commitMessage: string,
): Promise<{ sha: string; alreadyMerged: boolean }> {
  if (config.testData) {
    const match = config.testData.repositories.find((item) => item.id === repository.id);
    if (!match || installationId !== config.testData.installationId) throw new GitHubApiError("Repository is not available", 404);
    if (testMergeConflicts.delete(`${repository.id}:${headSha}`)) throw new GitHubApiError("The run conflicts with the candidate branch", 409);
    const key = `${installationId}:${repository.id}:${baseBranch}`;
    const baseSha = testRefs.get(key) ?? match.branchShas?.[baseBranch] ?? "1".repeat(40);
    if (baseSha === headSha) return { sha: baseSha, alreadyMerged: true };
    const input = new TextEncoder().encode(`${baseSha}:${headSha}:${commitMessage}`);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
    const sha = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
    testRefs.set(key, sha);
    return { sha, alreadyMerged: false };
  }
  const token = await createInstallationToken(config, installationId, repository.id);
  const response = await fetch(`${API_ROOT}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/merges`, {
    method: "POST",
    headers: { ...githubHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({ base: baseBranch, head: headSha, commit_message: commitMessage.slice(0, 250) }),
  });
  if (response.status === 204) return { sha: await getRepositoryRefSha(config, installationId, repository, baseBranch), alreadyMerged: true };
  if (!response.ok) throw await githubError(response);
  const body = await response.json() as { sha?: string };
  if (!body.sha) throw new GitHubApiError("GitHub did not return the integrated candidate SHA", 502);
  return { sha: body.sha, alreadyMerged: false };
}

export async function createDraftPullRequest(
  config: GitHubAppConfig,
  installationId: string,
  repository: GitHubRepositoryOption,
  input: { title: string; body: string; head: string; base: string },
): Promise<{ number: number; nodeId: string; url: string; state: "open" | "closed"; draft: boolean }> {
  const key = `${installationId}:${repository.id}:${input.head}:${input.base}`;
  if (config.testData) {
    const match = config.testData.repositories.find((item) => item.id === repository.id);
    if (!match || installationId !== config.testData.installationId) throw new GitHubApiError("Repository is not available", 404);
    const existing = testPullRequests.get(key);
    if (existing) return existing;
    const value: TestPullRequest = {
      number: testPullRequests.size + 1,
      nodeId: `PR_TEST_${testPullRequests.size + 1}`,
      url: `https://github.com/${repository.fullName}/pull/${testPullRequests.size + 1}`,
      state: "open",
      draft: true,
      merged: false,
      headRef: input.head,
      baseRef: input.base,
      mergeCommitSha: null,
    };
    testPullRequests.set(key, value);
    return value;
  }
  const token = await createInstallationToken(config, installationId, repository.id);
  const query = new URLSearchParams({ state: "open", head: `${repository.owner}:${input.head}`, base: input.base, per_page: "10" });
  const existingResponse = await githubFetch(
    `${API_ROOT}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls?${query}`,
    token,
  );
  const existing = await existingResponse.json() as Array<{ number?: number; node_id?: string; html_url?: string; state?: string; draft?: boolean }>;
  const found = existing.find((item) => item.number && item.node_id && item.html_url);
  if (found?.number && found.node_id && found.html_url) {
    return { number: found.number, nodeId: found.node_id, url: found.html_url, state: found.state === "closed" ? "closed" : "open", draft: found.draft !== false };
  }
  const response = await fetch(`${API_ROOT}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls`, {
    method: "POST",
    headers: { ...githubHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({ ...input, draft: true, maintainer_can_modify: false }),
  });
  if (!response.ok) throw await githubError(response);
  const body = await response.json() as { number?: number; node_id?: string; html_url?: string; state?: string; draft?: boolean };
  if (!body.number || !body.node_id || !body.html_url) throw new GitHubApiError("GitHub did not return the draft pull request", 502);
  return { number: body.number, nodeId: body.node_id, url: body.html_url, state: body.state === "closed" ? "closed" : "open", draft: body.draft !== false };
}

export async function getPullRequestReview(
  config: GitHubAppConfig,
  installationId: string,
  repository: GitHubRepositoryOption,
  pullRequestNumber: number,
): Promise<GitHubPullRequestReview> {
  if (config.testData) {
    const match = config.testData.repositories.find((item) => item.id === repository.id);
    if (!match || installationId !== config.testData.installationId) throw new GitHubApiError("Repository is not available", 404);
    const pullRequest = [...testPullRequests.values()].find((item) => item.number === pullRequestNumber && item.url.includes(`/${repository.fullName}/pull/`));
    if (!pullRequest) throw new GitHubApiError("Pull request is not available", 404);
    const headSha = await getRepositoryRefSha(config, installationId, repository, pullRequest.headRef).catch(() => pullRequest.mergeCommitSha ?? "0".repeat(40));
    const baseSha = await getRepositoryRefSha(config, installationId, repository, pullRequest.baseRef);
    return {
      ...pullRequest,
      mergeable: pullRequest.merged ? false : true,
      mergeableState: pullRequest.merged ? "unknown" : "clean",
      headSha,
      baseSha,
      checksPassing: true,
      files: [],
      checks: [],
    };
  }
  const token = await createInstallationToken(config, installationId, repository.id);
  const root = `${API_ROOT}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
  const response = await githubFetch(`${root}/pulls/${pullRequestNumber}`, token);
  const body = await response.json() as GitHubPullRequestRecord;
  if (!body.number || !body.node_id || !body.html_url || !body.head?.ref || !body.head.sha || !body.base?.ref || !body.base.sha) {
    throw new GitHubApiError("GitHub returned an incomplete pull request", 502);
  }
  const files: GitHubPullRequestReview["files"] = [];
  let patchBytes = 0;
  for (let page = 1; page <= 3; page += 1) {
    const filesResponse = await githubFetch(`${root}/pulls/${pullRequestNumber}/files?per_page=100&page=${page}`, token);
    const pageFiles = await filesResponse.json() as Array<{ filename?: string; status?: string; additions?: number; deletions?: number; patch?: string }>;
    for (const file of pageFiles) {
      if (!file.filename || files.length >= 250) throw new GitHubApiError("Pull request contains too many files for bounded review", 422);
      const remaining = Math.max(0, 1_000_000 - patchBytes);
      const patchPreview = (file.patch ?? "").slice(0, Math.min(20_000, remaining));
      patchBytes += new TextEncoder().encode(patchPreview).byteLength;
      files.push({
        path: file.filename,
        additions: Number(file.additions ?? 0),
        deletions: Number(file.deletions ?? 0),
        changeKind: file.status === "added" ? "add" : file.status === "removed" ? "delete" : "update",
        patchPreview,
      });
    }
    if (pageFiles.length < 100) break;
  }
  const [checksResponse, statusesResponse] = await Promise.all([
    githubFetch(`${root}/commits/${encodeURIComponent(body.head.sha)}/check-runs?filter=latest&per_page=100`, token),
    githubFetch(`${root}/commits/${encodeURIComponent(body.head.sha)}/status`, token),
  ]);
  const checkRuns = await checksResponse.json() as { check_runs?: Array<{ id?: number; name?: string; status?: string; conclusion?: string | null; details_url?: string | null }> };
  const statuses = await statusesResponse.json() as { statuses?: Array<{ id?: number; context?: string; state?: string; description?: string | null; target_url?: string | null }> };
  const checks: GitHubPullRequestReview["checks"] = [];
  for (const check of checkRuns.check_runs ?? []) {
    if (!check.id || !check.name) continue;
    const passed = check.status === "completed" && ["success", "neutral", "skipped"].includes(check.conclusion ?? "");
    const failed = check.status === "completed" && !passed;
    checks.push({ sourceId: `check:${check.id}`, name: check.name, detail: check.conclusion ?? check.status ?? null, state: passed ? "passed" : failed ? "failed" : "waiting" });
  }
  for (const status of statuses.statuses ?? []) {
    if (!status.id || !status.context) continue;
    checks.push({
      sourceId: `status:${status.id}`,
      name: status.context,
      detail: status.description ?? status.state ?? null,
      state: status.state === "success" ? "passed" : ["failure", "error"].includes(status.state ?? "") ? "failed" : "waiting",
    });
  }
  return {
    number: body.number,
    nodeId: body.node_id,
    url: body.html_url,
    state: body.state === "closed" ? "closed" : "open",
    draft: body.draft !== false,
    merged: body.merged === true,
    mergeable: typeof body.mergeable === "boolean" ? body.mergeable : null,
    mergeableState: body.mergeable_state ?? null,
    headRef: body.head.ref,
    headSha: body.head.sha,
    baseRef: body.base.ref,
    baseSha: body.base.sha,
    mergeCommitSha: body.merged && body.merge_commit_sha ? body.merge_commit_sha : null,
    checksPassing: checks.every((check) => check.state === "passed"),
    files,
    checks,
  };
}

const PULL_REQUEST_FEEDBACK_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number id url state merged headRefOid reviewDecision
      reviewThreads(first: 100) {
        nodes {
          id isResolved isOutdated
          comments(first: 50) { nodes { databaseId url body path line author { __typename login } } }
        }
      }
      latestOpinionatedReviews(first: 50) { nodes { databaseId state body url author { __typename login } } }
      commits(last: 1) {
        nodes { commit { oid statusCheckRollup { contexts(first: 100) { nodes {
          __typename
          ... on CheckRun { name status conclusion detailsUrl }
          ... on StatusContext { context state targetUrl }
        } } } } }
      }
    }
  }
}`;

export type PullRequestFeedbackPayload = {
  repository?: {
    pullRequest?: {
      number?: number; id?: string; url?: string; state?: string; merged?: boolean; headRefOid?: string; reviewDecision?: string | null;
      reviewThreads?: { nodes?: Array<{
        id?: string; isResolved?: boolean; isOutdated?: boolean;
        comments?: { nodes?: Array<{ databaseId?: number; url?: string; body?: string; path?: string | null; line?: number | null; author?: { __typename?: string; login?: string } | null }> };
      }> };
      latestOpinionatedReviews?: { nodes?: Array<{ databaseId?: number; state?: string; body?: string; url?: string; author?: { __typename?: string; login?: string } | null }> };
      commits?: { nodes?: Array<{ commit?: { oid?: string; statusCheckRollup?: { contexts?: { nodes?: Array<{
        __typename?: string; name?: string; status?: string; conclusion?: string | null; detailsUrl?: string | null;
        context?: string; state?: string; targetUrl?: string | null;
      }> } } | null } }> };
    } | null;
  } | null;
};

const FAILING_CHECK_CONCLUSIONS = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const FAILING_STATUS_STATES = new Set(["FAILURE", "ERROR"]);

// Pure GraphQL → facts mapping (agent-orchestrator's adapters/scm/github
// rules): failure-class conclusions only, resolved/outdated threads dropped,
// bot authors dropped by __typename (never by a login substring), and only
// CHANGES_REQUESTED opinionated reviews kept.
export function mapPullRequestFeedback(payload: PullRequestFeedbackPayload): GitHubPullRequestFeedback {
  const pr = payload.repository?.pullRequest;
  if (!pr?.number || !pr.id || !pr.url || !pr.headRefOid) throw new GitHubApiError("GitHub returned an incomplete pull request", 502);
  const contexts = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  const failedChecks: GitHubPullRequestFeedback["failedChecks"] = [];
  for (const context of contexts) {
    if (context.__typename === "CheckRun" && context.status === "COMPLETED" && FAILING_CHECK_CONCLUSIONS.has(context.conclusion ?? "")) {
      failedChecks.push({ name: context.name ?? "unnamed check", status: (context.conclusion ?? "failure").toLowerCase(), url: context.detailsUrl ?? null });
    } else if (context.__typename === "StatusContext" && FAILING_STATUS_STATES.has(context.state ?? "")) {
      failedChecks.push({ name: context.context ?? "unnamed status", status: (context.state ?? "failure").toLowerCase(), url: context.targetUrl ?? null });
    }
  }
  const unresolvedThreads: GitHubPullRequestFeedback["unresolvedThreads"] = [];
  for (const thread of pr.reviewThreads?.nodes ?? []) {
    if (!thread.id || thread.isResolved || thread.isOutdated) continue;
    const comments = (thread.comments?.nodes ?? [])
      .filter((comment) => comment.databaseId && comment.url && comment.author?.__typename !== "Bot")
      .map((comment) => ({
        id: String(comment.databaseId), author: comment.author?.login ?? "", body: (comment.body ?? "").slice(0, 2_000),
        path: comment.path ?? null, line: comment.line ?? null, url: comment.url!,
      }));
    if (comments.length > 0) unresolvedThreads.push({ threadId: thread.id, comments });
  }
  const changesRequested = (pr.latestOpinionatedReviews?.nodes ?? [])
    .filter((review) => review.databaseId && review.url && review.state === "CHANGES_REQUESTED" && review.author?.__typename !== "Bot")
    .map((review) => ({ id: String(review.databaseId), author: review.author?.login ?? "", body: (review.body ?? "").slice(0, 2_000), url: review.url! }));
  const decision = pr.reviewDecision === "APPROVED" ? "approved" : pr.reviewDecision === "CHANGES_REQUESTED" ? "changes_requested" : pr.reviewDecision === "REVIEW_REQUIRED" ? "review_required" : null;
  return {
    number: pr.number, nodeId: pr.id, url: pr.url, state: pr.state === "OPEN" ? "open" : "closed", merged: pr.merged === true,
    headSha: pr.headRefOid, reviewDecision: decision, failedChecks, unresolvedThreads, changesRequested,
  };
}

export async function getPullRequestFeedback(
  config: GitHubAppConfig,
  installationId: string,
  repository: GitHubRepositoryOption,
  pullRequestNumber: number,
): Promise<GitHubPullRequestFeedback> {
  if (config.testData) {
    const match = config.testData.repositories.find((item) => item.id === repository.id);
    if (!match || installationId !== config.testData.installationId) throw new GitHubApiError("Repository is not available", 404);
    return {
      number: pullRequestNumber, nodeId: `PR_${pullRequestNumber}`, url: `https://github.com/${repository.fullName}/pull/${pullRequestNumber}`,
      state: "open", merged: false, headSha: "0".repeat(40), reviewDecision: null, failedChecks: [], unresolvedThreads: [], changesRequested: [],
      ...testPullRequestFeedback.get(`${repository.id}:${pullRequestNumber}`),
    };
  }
  const token = await createInstallationToken(config, installationId, repository.id);
  const data = await githubGraphql<PullRequestFeedbackPayload>(token, PULL_REQUEST_FEEDBACK_QUERY, { owner: repository.owner, name: repository.name, number: pullRequestNumber });
  return mapPullRequestFeedback(data);
}

export async function markPullRequestReadyForReview(
  config: GitHubAppConfig,
  installationId: string,
  repository: GitHubRepositoryOption,
  nodeId: string,
): Promise<void> {
  if (config.testData) {
    const pullRequest = [...testPullRequests.values()].find((item) => item.nodeId === nodeId);
    if (!pullRequest) throw new GitHubApiError("Pull request is not available", 404);
    pullRequest.draft = false;
    return;
  }
  const token = await createInstallationToken(config, installationId, repository.id);
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { ...githubHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({
      query: "mutation MarkReady($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { id isDraft } } }",
      variables: { id: nodeId },
    }),
  });
  const body = await response.json() as { data?: { markPullRequestReadyForReview?: { pullRequest?: { isDraft?: boolean } } }; errors?: Array<{ message?: string }> };
  if (!response.ok || body.errors?.length || body.data?.markPullRequestReadyForReview?.pullRequest?.isDraft !== false) {
    throw new GitHubApiError(body.errors?.[0]?.message ?? "GitHub did not mark the pull request ready", response.ok ? 422 : response.status);
  }
}

export async function convertPullRequestToDraft(
  config: GitHubAppConfig,
  installationId: string,
  repository: GitHubRepositoryOption,
  nodeId: string,
): Promise<void> {
  if (config.testData) {
    const pullRequest = [...testPullRequests.values()].find((item) => item.nodeId === nodeId);
    if (!pullRequest) throw new GitHubApiError("Pull request is not available", 404);
    pullRequest.draft = true;
    return;
  }
  const token = await createInstallationToken(config, installationId, repository.id);
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { ...githubHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({
      query: "mutation ConvertToDraft($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { id isDraft } } }",
      variables: { id: nodeId },
    }),
  });
  const body = await response.json() as { data?: { convertPullRequestToDraft?: { pullRequest?: { isDraft?: boolean } } }; errors?: Array<{ message?: string }> };
  if (!response.ok || body.errors?.length || body.data?.convertPullRequestToDraft?.pullRequest?.isDraft !== true) {
    throw new GitHubApiError(body.errors?.[0]?.message ?? "GitHub did not convert the pull request to a draft", response.ok ? 422 : response.status);
  }
}

// The squash commit's message body: one Co-authored-by trailer per session
// member (ENG-65), so GitHub credits the whole team on the merged commit.
// Deduped by email, name flattened to one trailer-safe line. Null when there
// is nobody to credit — the caller then leaves GitHub's default message.
export function coauthorTrailers(members: { displayName: string; email: string }[]): string | null {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const member of members) {
    const email = member.email.trim();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const name = member.displayName.replace(/[<>\r\n]+/g, " ").replace(/\s+/g, " ").trim() || email;
    lines.push(`Co-authored-by: ${name} <${email}>`);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

export async function squashMergePullRequest(
  config: GitHubAppConfig,
  installationId: string,
  repository: GitHubRepositoryOption,
  pullRequestNumber: number,
  expectedHeadSha: string,
  commitMessage?: string | null,
): Promise<{ sha: string }> {
  if (config.testData) {
    const pullRequest = [...testPullRequests.values()].find((item) => item.number === pullRequestNumber && item.url.includes(`/${repository.fullName}/pull/`));
    if (!pullRequest || pullRequest.state !== "open" || pullRequest.draft) throw new GitHubApiError("Pull request is not mergeable", 405);
    const headSha = await getRepositoryRefSha(config, installationId, repository, pullRequest.headRef);
    if (headSha !== expectedHeadSha) throw new GitHubApiError("Pull request head changed", 409);
    const baseSha = await getRepositoryRefSha(config, installationId, repository, pullRequest.baseRef);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(`${baseSha}:${headSha}:squash`)));
    const sha = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
    testRefs.set(`${installationId}:${repository.id}:${pullRequest.baseRef}`, sha);
    pullRequest.state = "closed";
    pullRequest.merged = true;
    pullRequest.mergeCommitSha = sha;
    return { sha };
  }
  const token = await createInstallationToken(config, installationId, repository.id);
  const response = await fetch(`${API_ROOT}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls/${pullRequestNumber}/merge`, {
    method: "PUT",
    headers: { ...githubHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({ sha: expectedHeadSha, merge_method: "squash", ...(commitMessage ? { commit_message: commitMessage } : {}) }),
  });
  const body = await response.json() as { merged?: boolean; sha?: string; message?: string };
  if (!response.ok || !body.merged || !body.sha) throw new GitHubApiError(body.message ?? "GitHub rejected the squash merge", response.status || 409);
  return { sha: body.sha };
}

export async function deleteTestRepositoryBranchIfMatches(
  config: GitHubAppConfig,
  installationId: string,
  repository: GitHubRepositoryOption,
  branch: string,
  expectedSha: string,
): Promise<boolean> {
  if (!config.testData) throw new GitHubApiError("Test repository adapter is unavailable", 500);
  if (!branch.startsWith("openfloor/") || !/^[a-z0-9/_-]+$/.test(branch)) throw new GitHubApiError("openfloor generated an invalid branch", 500);
  const match = config.testData.repositories.find((item) => item.id === repository.id);
  if (!match || installationId !== config.testData.installationId) throw new GitHubApiError("Repository is not available", 404);
  const key = `${installationId}:${repository.id}:${branch}`;
  const current = testRefs.get(key);
  if (current !== expectedSha) return false;
  testRefs.delete(key);
  return true;
}

export async function downloadRepositoryArchive(
  config: GitHubAppConfig,
  installationId: string,
  repository: GitHubRepositoryOption,
  sha: string,
): Promise<Response> {
  const token = await createInstallationToken(config, installationId, repository.id);
  const response = await fetch(
    `${API_ROOT}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/tarball/${encodeURIComponent(sha)}`,
    { headers: githubHeaders(token), redirect: "follow" },
  );
  if (!response.ok) throw await githubError(response);
  return response;
}

const MAX_TREE_ENTRIES = 10_000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILE_LINES = 5_000;

function assertSafeRepositoryRef(ref: string): void {
  if (!ref || ref.includes("..") || ref.startsWith("/") || /[\s\0]/.test(ref)) throw new GitHubApiError("Invalid repository ref", 400);
}

function assertSafeRepositoryPath(path: string): void {
  if (!path || path.startsWith("/") || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new GitHubApiError("Invalid repository path", 400);
  }
}

/** Recursive repository tree at `ref` (a branch name or full commit SHA), bounded so a huge
    monorepo can't blow up the response — same discipline as getPullRequestReview's file caps. */
export async function listRepositoryTree(
  config: GitHubAppConfig,
  installationId: string,
  repository: GitHubRepositoryOption,
  ref: string,
): Promise<RepositoryTree> {
  assertSafeRepositoryRef(ref);
  if (config.testData) {
    const match = config.testData.repositories.find((item) => item.id === repository.id);
    if (!match || installationId !== config.testData.installationId) throw new GitHubApiError("Repository is not available", 404);
    const files = match.files ?? {};
    const dirs = new Set<string>();
    const entries: RepositoryTreeEntry[] = [];
    for (const path of Object.keys(files)) {
      const segments = path.split("/");
      for (let index = 1; index < segments.length; index += 1) {
        const dir = segments.slice(0, index).join("/");
        if (!dirs.has(dir)) {
          dirs.add(dir);
          entries.push({ path: dir, type: "dir", size: null, sha: "0".repeat(40) });
        }
      }
      entries.push({ path, type: "file", size: new TextEncoder().encode(files[path]).byteLength, sha: "0".repeat(40) });
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return { ref, sha: "0".repeat(40), entries, truncated: false };
  }
  const token = await createInstallationToken(config, installationId, repository.id);
  const response = await githubFetch(
    `${API_ROOT}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    token,
  );
  const body = await response.json() as {
    sha?: string;
    truncated?: boolean;
    tree?: Array<{ path?: string; type?: string; size?: number; sha?: string }>;
  };
  if (!body.sha) throw new GitHubApiError("GitHub did not return a tree SHA", 502);
  const entries: RepositoryTreeEntry[] = [];
  for (const item of body.tree ?? []) {
    if (!item.path || !item.sha) continue;
    if (item.type === "blob") entries.push({ path: item.path, type: "file", size: typeof item.size === "number" ? item.size : null, sha: item.sha });
    else if (item.type === "tree") entries.push({ path: item.path, type: "dir", size: null, sha: item.sha });
    // "commit" entries are submodules; intentionally dropped — there is nothing to browse into.
  }
  const truncated = body.truncated === true || entries.length > MAX_TREE_ENTRIES;
  return { ref, sha: body.sha, entries: entries.slice(0, MAX_TREE_ENTRIES), truncated };
}

/** A single file's contents at `ref`, bounded to MAX_FILE_BYTES and MAX_FILE_LINES so a large
    or binary blob never lands whole in a browser tab. */
export async function getRepositoryFileContent(
  config: GitHubAppConfig,
  installationId: string,
  repository: GitHubRepositoryOption,
  ref: string,
  path: string,
): Promise<RepositoryFileContent> {
  assertSafeRepositoryRef(ref);
  assertSafeRepositoryPath(path);
  if (config.testData) {
    const match = config.testData.repositories.find((item) => item.id === repository.id);
    if (!match || installationId !== config.testData.installationId) throw new GitHubApiError("Repository is not available", 404);
    const content = match.files?.[path];
    if (content === undefined) throw new GitHubApiError("File is not available", 404);
    return decodeRepositoryFile(path, new TextEncoder().encode(content));
  }
  const token = await createInstallationToken(config, installationId, repository.id);
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const response = await githubFetch(
    `${API_ROOT}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
    token,
  );
  const body = await response.json() as { content?: string; encoding?: string; size?: number; type?: string };
  if (body.type && body.type !== "file") throw new GitHubApiError("Path is not a file", 400);
  if (typeof body.size === "number" && body.size > MAX_FILE_BYTES) return { path, encoding: "too_large", size: body.size };
  if (typeof body.content !== "string" || body.encoding !== "base64") throw new GitHubApiError("GitHub did not return file contents", 502);
  const bytes = base64ToBytes(body.content.replace(/\n/g, ""));
  return decodeRepositoryFile(path, bytes);
}

function decodeRepositoryFile(path: string, bytes: Uint8Array): RepositoryFileContent {
  if (bytes.byteLength > MAX_FILE_BYTES) return { path, encoding: "too_large", size: bytes.byteLength };
  if (bytes.includes(0)) return { path, encoding: "binary", size: bytes.byteLength };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { path, encoding: "binary", size: bytes.byteLength };
  }
  const lines = text.split("\n");
  const truncated = lines.length > MAX_FILE_LINES;
  return { path, encoding: "text", text: truncated ? lines.slice(0, MAX_FILE_LINES).join("\n") : text, size: bytes.byteLength, truncated };
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export class GitHubApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "GitHubApiError";
  }
}

type GitHubRepositoryRecord = {
  id: number | string;
  node_id: string;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  owner: { login: string };
};

type GitHubPullRequestRecord = {
  number?: number;
  node_id?: string;
  html_url?: string;
  state?: string;
  draft?: boolean;
  merged?: boolean;
  mergeable?: boolean | null;
  mergeable_state?: string | null;
  merge_commit_sha?: string | null;
  head?: { ref?: string; sha?: string };
  base?: { ref?: string; sha?: string };
};

function mapRepository(repository: GitHubRepositoryRecord): GitHubRepositoryOption {
  return {
    id: String(repository.id),
    nodeId: repository.node_id,
    owner: repository.owner.login,
    name: repository.name,
    fullName: repository.full_name,
    private: repository.private,
    defaultBranch: repository.default_branch,
  };
}

// Installation tokens live for an hour; most helpers mint one per call, which
// costs an RS256 sign plus a GitHub round trip each time. Cache per isolate,
// dropping tokens ten minutes before expiry so a cached token always survives
// the request it is handed to. Best-effort: isolates are ephemeral, and a
// mid-hour permission revocation surfaces as a 401 exactly as it would today.
const installationTokenCache = new Map<string, { token: string; expiresAt: number }>();
const TOKEN_EXPIRY_MARGIN_MS = 10 * 60 * 1000;

export async function createInstallationToken(
  config: GitHubAppConfig,
  installationId: string,
  repositoryId?: string,
): Promise<string> {
  const cacheKey = `${config.appId}:${installationId}:${repositoryId ?? "*"}`;
  const cached = installationTokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt - TOKEN_EXPIRY_MARGIN_MS) return cached.token;
  installationTokenCache.delete(cacheKey);
  const appJwt = await createGitHubAppJwt(config);
  const response = await fetch(`${API_ROOT}/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
    method: "POST",
    headers: githubHeaders(appJwt),
    body: JSON.stringify(repositoryId ? { repository_ids: [Number(repositoryId)] } : {}),
  });
  if (!response.ok) throw await githubError(response);
  const body = await response.json() as { token?: string; expires_at?: string };
  if (!body.token) throw new GitHubApiError("GitHub did not return an installation token", 502);
  const expiresAt = body.expires_at ? Date.parse(body.expires_at) : Number.NaN;
  if (Number.isFinite(expiresAt)) installationTokenCache.set(cacheKey, { token: body.token, expiresAt });
  return body.token;
}

async function createGitHubAppJwt(config: GitHubAppConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  let key: Awaited<ReturnType<typeof importPKCS8>>;
  try {
    key = await importGitHubAppPrivateKey(config.privateKey);
  } catch {
    throw new GitHubApiError("GitHub App private key could not be read", 500);
  }
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 9 * 60)
    .setIssuer(config.appId)
    .sign(key);
}

export async function importGitHubAppPrivateKey(value: string) {
  const pem = value.replace(/\\n/g, "\n").trim();
  if (pem.includes("-----BEGIN PRIVATE KEY-----")) return importPKCS8(pem, "RS256");
  if (!pem.includes("-----BEGIN RSA PRIVATE KEY-----")) {
    throw new TypeError("GitHub App private key is not PKCS#1 or PKCS#8 PEM");
  }
  return importPKCS8(pkcs1ToPkcs8Pem(pem), "RS256");
}

function pkcs1ToPkcs8Pem(pem: string): string {
  const encoded = pem
    .replace("-----BEGIN RSA PRIVATE KEY-----", "")
    .replace("-----END RSA PRIVATE KEY-----", "")
    .replace(/\s/g, "");
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new TypeError("GitHub App PKCS#1 private key is invalid");
  }
  const binary = atob(encoded);
  const pkcs1 = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaAlgorithm = Uint8Array.of(
    0x30, 0x0d,
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    0x05, 0x00,
  );
  const privateKey = derValue(0x04, pkcs1);
  const pkcs8 = derValue(0x30, concatBytes(version, rsaAlgorithm, privateKey));
  let pkcs8Binary = "";
  for (const byte of pkcs8) pkcs8Binary += String.fromCharCode(byte);
  const lines = btoa(pkcs8Binary).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
}

function derValue(tag: number, value: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(tag), derLength(value.length), value);
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>>= 8;
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function concatBytes(...values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((total, value) => total + value.length, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

async function githubFetch(url: string, token: string): Promise<Response> {
  const response = await fetch(url, { headers: githubHeaders(token) });
  if (!response.ok) throw await githubError(response);
  return response;
}

// Installation tokens are valid for GraphQL with the same Bearer header;
// GraphQL reports failures as a 200 with `errors`, so both are checked.
async function githubGraphql<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${API_ROOT}/graphql`, {
    method: "POST",
    headers: { ...githubHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw await githubError(response);
  const body = await response.json() as { data?: T; errors?: Array<{ message?: string }> };
  if (body.errors?.length) throw new GitHubApiError(body.errors.map((error) => error.message ?? "GraphQL error").join("; ").slice(0, 500), 502);
  if (!body.data) throw new GitHubApiError("GitHub returned no GraphQL data", 502);
  return body.data;
}

function githubHeaders(token: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "openfloor-GitHub-App",
    "X-GitHub-Api-Version": API_VERSION,
  };
}

async function githubError(response: Response): Promise<GitHubApiError> {
  let message = `GitHub request failed with status ${response.status}`;
  try {
    const body = await response.json() as { message?: string };
    if (body.message) message = body.message;
  } catch {
    // Preserve the bounded status-only message when GitHub does not return JSON.
  }
  return new GitHubApiError(message, response.status);
}
