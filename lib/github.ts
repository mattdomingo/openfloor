import { SignJWT, importPKCS8 } from "jose";
import { BASE_PATH } from "@/components/basePath";
import type { GitHubRepositoryOption } from "@/lib/session-types";

export type GitHubTestRepository = GitHubRepositoryOption & { branches: string[]; branchShas?: Record<string, string> };

export type GitHubAppConfig = {
  appId: string;
  privateKey: string;
  slug: string;
  stateSecret: string;
  webhookSecret: string;
  testData: { installationId: string; repositories: GitHubTestRepository[] } | null;
};

const API_ROOT = "https://api.github.com";
const API_VERSION = "2026-03-10";
const testRefs = new Map<string, string>();
const testMergeConflicts = new Set<string>();
const testPullRequests = new Map<string, { number: number; nodeId: string; url: string; state: "open"; draft: boolean }>();

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
    throw new GitHubApiError("OpenFloor generated an invalid branch", 500);
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
    const value = { number: testPullRequests.size + 1, nodeId: `PR_TEST_${testPullRequests.size + 1}`, url: `https://github.com/${repository.fullName}/pull/${testPullRequests.size + 1}`, state: "open" as const, draft: true };
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

export async function deleteTestRepositoryBranchIfMatches(
  config: GitHubAppConfig,
  installationId: string,
  repository: GitHubRepositoryOption,
  branch: string,
  expectedSha: string,
): Promise<boolean> {
  if (!config.testData) throw new GitHubApiError("Test repository adapter is unavailable", 500);
  if (!branch.startsWith("openfloor/") || !/^[a-z0-9/_-]+$/.test(branch)) throw new GitHubApiError("OpenFloor generated an invalid branch", 500);
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

export async function createInstallationToken(
  config: GitHubAppConfig,
  installationId: string,
  repositoryId?: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  let key: Awaited<ReturnType<typeof importPKCS8>>;
  try {
    key = await importGitHubAppPrivateKey(config.privateKey);
  } catch {
    throw new GitHubApiError("GitHub App private key could not be read", 500);
  }
  const appJwt = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 9 * 60)
    .setIssuer(config.appId)
    .sign(key);
  const response = await fetch(`${API_ROOT}/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
    method: "POST",
    headers: githubHeaders(appJwt),
    body: JSON.stringify(repositoryId ? { repository_ids: [Number(repositoryId)] } : {}),
  });
  if (!response.ok) throw await githubError(response);
  const body = await response.json() as { token?: string };
  if (!body.token) throw new GitHubApiError("GitHub did not return an installation token", 502);
  return body.token;
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

function githubHeaders(token: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "OpenFloor-GitHub-App",
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
