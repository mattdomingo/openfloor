import type {
  AccountGitHubRepositoryOption,
  UserGitHubInstallationSummary,
} from "@/lib/session-types";
import type { GitHubAppConfig } from "@/lib/github";
import type { GitHubRepositoryOption } from "@/lib/session-types";
import { GitHubApiError, listInstallationRepositories } from "@/lib/github";
import { deduplicateAccountGitHubRepositories } from "@/lib/account-github-repositories";
import { getDb, type D1DatabaseLike } from "./index";

export type GitHubAccountConnectionPurpose = "onboarding" | "settings";

type InstallationRecord = UserGitHubInstallationSummary & { installationId: string; repoScope: string | null };

export async function createGitHubAccountConnectionState(
  userId: string,
  purpose: GitHubAccountConnectionPurpose,
  returnTo: string,
  database = getDb(),
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await database.batch([
    database.prepare(
      "UPDATE github_account_connection_states SET expires_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL",
    ).bind(now, userId, purpose),
    database.prepare(
      `INSERT INTO github_account_connection_states
       (id, user_id, purpose, return_to, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(id, userId, purpose, returnTo, now, now + 30 * 60 * 1000),
  ]);
  return id;
}

export async function consumeGitHubAccountConnectionState(
  stateId: string,
  userId: string,
  installationId: string,
  account: { login: string; type: string } | null,
  repoScope: string[],
  database = getDb(),
): Promise<{ purpose: GitHubAccountConnectionPurpose; returnTo: string } | null> {
  const now = Date.now();
  const statements = [];
  if (account && repoScope.length > 0) {
    statements.push(database.prepare(
      `INSERT INTO user_github_installations
       (id, user_id, installation_id, account_login, account_type, status, repo_scope, connected_at, updated_at)
       SELECT ?, user_id, ?, ?, ?, 'active', ?, ?, ?
       FROM github_account_connection_states
       WHERE id = ? AND user_id = ? AND used_at IS NULL AND expires_at > ?
       ON CONFLICT(user_id, installation_id) DO UPDATE SET
         account_login = excluded.account_login,
         account_type = excluded.account_type,
         status = 'active',
         repo_scope = excluded.repo_scope,
         updated_at = excluded.updated_at`,
    ).bind(crypto.randomUUID(), installationId, account.login, account.type, JSON.stringify(repoScope), now, now, stateId, userId, now));
  }
  statements.push(database.prepare(
    `UPDATE github_account_connection_states SET used_at = ?
     WHERE id = ? AND user_id = ? AND used_at IS NULL AND expires_at > ?`,
  ).bind(now, stateId, userId, now));
  const results = await database.batch(statements);
  const consumedResult = results[results.length - 1];
  if (!consumedResult?.success || Number(consumedResult.meta?.changes ?? 0) !== 1) return null;
  return database.prepare(
    "SELECT purpose, return_to AS returnTo FROM github_account_connection_states WHERE id = ? AND user_id = ?",
  ).bind(stateId, userId).first<{ purpose: GitHubAccountConnectionPurpose; returnTo: string }>();
}

/** Device-flow linking: upserts an installation association directly. The
    browser-redirect path keeps its one-time signed state (above); here the
    proof is the user-to-server token that just listed this installation.
    repoScope is the repository-id list that token could reach inside the
    installation — stored so this member never sees more than GitHub grants
    them. */
export async function linkUserGitHubInstallation(
  userId: string,
  installationId: string,
  account: { login: string; type: string },
  repoScope: string[],
  database = getDb(),
): Promise<void> {
  if (repoScope.length === 0) return;
  const now = Date.now();
  await database.prepare(
    `INSERT INTO user_github_installations
     (id, user_id, installation_id, account_login, account_type, status, repo_scope, connected_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
     ON CONFLICT(user_id, installation_id) DO UPDATE SET
       account_login = excluded.account_login,
       account_type = excluded.account_type,
       status = 'active',
       repo_scope = excluded.repo_scope,
       updated_at = excluded.updated_at`,
  ).bind(crypto.randomUUID(), userId, installationId, account.login, account.type, JSON.stringify(repoScope), now, now).run();
}

/** Fail closed: a missing or malformed scope grants nothing. Every writer
    stores an explicit JSON list, so NULL only means "predates scoping". */
function parseRepoScope(repoScope: string | null): Set<string> {
  if (!repoScope) return new Set();
  try {
    const parsed = JSON.parse(repoScope) as unknown;
    return Array.isArray(parsed) ? new Set(parsed.filter((id): id is string => typeof id === "string")) : new Set();
  } catch {
    return new Set();
  }
}

export async function listUserGitHubInstallations(
  userId: string,
  database = getDb(),
): Promise<UserGitHubInstallationSummary[]> {
  const rows = await database.prepare(
    `SELECT id, account_login AS accountLogin, account_type AS accountType, status,
            json_array_length(repo_scope) AS repoCount,
            connected_at AS connectedAt, updated_at AS updatedAt
     FROM user_github_installations
     WHERE user_id = ? AND json_valid(repo_scope) AND json_array_length(repo_scope) > 0
     ORDER BY account_login COLLATE NOCASE, connected_at`,
  ).bind(userId).all<UserGitHubInstallationSummary>();
  return rows.results;
}

export async function hasActiveUserGitHubInstallation(
  userId: string,
  database = getDb(),
): Promise<boolean> {
  return Boolean(await database.prepare(
    `SELECT 1 AS present FROM user_github_installations
     WHERE user_id = ? AND status = 'active' AND json_valid(repo_scope)
       AND json_array_length(repo_scope) > 0 LIMIT 1`,
  ).bind(userId).first());
}

export async function removeUserGitHubInstallation(
  userId: string,
  associationId: string,
  database = getDb(),
): Promise<boolean> {
  const result = await database.prepare(
    "DELETE FROM user_github_installations WHERE id = ? AND user_id = ?",
  ).bind(associationId, userId).run();
  return result.success && Number(result.meta?.changes ?? 0) === 1;
}

export async function setUserGitHubInstallationStatus(
  installationId: string | null,
  status: "active" | "revoked",
  database = getDb(),
): Promise<void> {
  if (!installationId) return;
  await database.prepare(
    "UPDATE user_github_installations SET status = ?, updated_at = ? WHERE installation_id = ?",
  ).bind(status, Date.now(), installationId).run();
}

export async function listAccountGitHubRepositories(
  userId: string,
  config: GitHubAppConfig,
  database = getDb(),
): Promise<AccountGitHubRepositoryOption[]> {
  const installations = await activeInstallationRecords(userId, database);
  const options: AccountGitHubRepositoryOption[] = [];
  for (const installation of installations) {
    let repositories: GitHubRepositoryOption[];
    try {
      repositories = await listInstallationRepositories(config, installation.installationId);
    } catch (error) {
      // A GitHub-side uninstall whose webhook never landed leaves a stale
      // active row; one dead installation must not blank out the rest.
      if (error instanceof GitHubApiError && error.status === 404) {
        await setUserGitHubInstallationStatus(installation.installationId, "revoked", database);
        continue;
      }
      throw error;
    }
    // The installation token sees every repo in the installation; this member
    // may not. Show only what their own token could reach at link time.
    const scope = parseRepoScope(installation.repoScope);
    options.push(...repositories.filter((repository) => scope.has(repository.id))
      .map((repository) => ({ ...repository, accountInstallationId: installation.id })));
  }
  return deduplicateAccountGitHubRepositories(options);
}

export async function resolveAccountGitHubRepository(
  userId: string,
  associationId: string,
  repositoryId: string,
  config: GitHubAppConfig,
  database = getDb(),
): Promise<{ installationId: string; repository: GitHubRepositoryOption } | null> {
  const installation = await database.prepare(
    `SELECT installation_id AS installationId, repo_scope AS repoScope FROM user_github_installations
     WHERE id = ? AND user_id = ? AND status = 'active'`,
  ).bind(associationId, userId).first<{ installationId: string; repoScope: string | null }>();
  if (!installation) return null;
  if (!parseRepoScope(installation.repoScope).has(repositoryId)) return null;
  const repository = (await listInstallationRepositories(config, installation.installationId))
    .find((item) => item.id === repositoryId);
  return repository ? { installationId: installation.installationId, repository } : null;
}

async function activeInstallationRecords(
  userId: string,
  database: D1DatabaseLike,
): Promise<InstallationRecord[]> {
  const rows = await database.prepare(
    `SELECT id, installation_id AS installationId, account_login AS accountLogin,
            account_type AS accountType, status, repo_scope AS repoScope,
            connected_at AS connectedAt, updated_at AS updatedAt
     FROM user_github_installations
     WHERE user_id = ? AND status = 'active' AND json_valid(repo_scope) AND json_array_length(repo_scope) > 0
     ORDER BY connected_at, id`,
  ).bind(userId).all<InstallationRecord>();
  return rows.results;
}
