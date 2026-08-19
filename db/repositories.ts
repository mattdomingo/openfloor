import type { GitHubRepositoryOption, RepositoryConnection, RepositoryCheckCommand } from "@/lib/session-types";
import { getDb, type D1DatabaseLike } from "./index";
import { getMembershipRole } from "./sessions";

type RepositoryConnectionRecord = Omit<RepositoryConnection, "repositoryPrivate" | "checkCommands"> & {
  repositoryPrivate: number | boolean;
};

export async function createGitHubConnectionState(
  sessionId: string,
  userId: string,
  database = getDb(),
): Promise<string | null> {
  if ((await getMembershipRole(sessionId, userId, database)) !== "owner") return null;
  const now = Date.now();
  const id = crypto.randomUUID();
  await database.batch([
    database
      .prepare("UPDATE github_connection_states SET expires_at = ? WHERE session_id = ? AND user_id = ? AND configured_at IS NULL")
      .bind(now, sessionId, userId),
    database
      .prepare(
        `INSERT INTO github_connection_states (id, session_id, user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(id, sessionId, userId, now, now + 30 * 60 * 1000),
  ]);
  return id;
}

export async function consumeGitHubConnectionState(
  stateId: string,
  userId: string,
  installationId: string,
  database = getDb(),
): Promise<{ sessionId: string } | null> {
  const now = Date.now();
  const result = await database
    .prepare(
      `UPDATE github_connection_states
       SET installation_id = ?, used_at = ?
       WHERE id = ? AND user_id = ? AND used_at IS NULL AND expires_at > ?
         AND EXISTS (
           SELECT 1 FROM session_members sm
           WHERE sm.session_id = github_connection_states.session_id
             AND sm.user_id = ? AND sm.role = 'owner'
         )`,
    )
    .bind(installationId, now, stateId, userId, now, userId)
    .run();
  if (!result.success || Number(result.meta?.changes ?? 0) !== 1) return null;
  return database
    .prepare("SELECT session_id AS sessionId FROM github_connection_states WHERE id = ?")
    .bind(stateId)
    .first<{ sessionId: string }>();
}

export async function getPendingGitHubInstallation(
  sessionId: string,
  userId: string,
  database = getDb(),
): Promise<{ stateId: string; installationId: string } | null> {
  if ((await getMembershipRole(sessionId, userId, database)) !== "owner") return null;
  return database
    .prepare(
      `SELECT id AS stateId, installation_id AS installationId
       FROM github_connection_states
       WHERE session_id = ? AND user_id = ? AND used_at IS NOT NULL
         AND configured_at IS NULL AND expires_at > ? AND installation_id IS NOT NULL
       ORDER BY used_at DESC LIMIT 1`,
    )
    .bind(sessionId, userId, Date.now())
    .first<{ stateId: string; installationId: string }>();
}

export async function getRepositoryConnectionForMember(
  sessionId: string,
  userId: string,
  database = getDb(),
): Promise<RepositoryConnection | null> {
  if (!(await getMembershipRole(sessionId, userId, database))) return null;
  const record = await database
    .prepare(
      `SELECT id, session_id AS sessionId, installation_id AS installationId,
              repository_id AS repositoryId, repository_node_id AS repositoryNodeId,
              repository_owner AS repositoryOwner, repository_name AS repositoryName,
              repository_full_name AS repositoryFullName, repository_private AS repositoryPrivate,
              default_branch AS defaultBranch, base_branch AS baseBranch, status,
              connected_by AS connectedBy, connected_at AS connectedAt, updated_at AS updatedAt,
              disconnected_at AS disconnectedAt
       FROM repository_connections WHERE session_id = ?`,
    )
    .bind(sessionId)
    .first<RepositoryConnectionRecord>();
  if (!record) return null;
  const commands = await database
    .prepare(
      `SELECT id, position, command FROM repository_check_commands
       WHERE connection_id = ? ORDER BY position`,
    )
    .bind(record.id)
    .all<RepositoryCheckCommand>();
  return {
    ...record,
    repositoryPrivate: Boolean(record.repositoryPrivate),
    checkCommands: commands.results.map((command) => ({ ...command, position: Number(command.position) })),
  };
}

export async function saveRepositoryConnection(
  sessionId: string,
  userId: string,
  stateId: string | null,
  installationId: string,
  repository: GitHubRepositoryOption,
  baseBranch: string,
  checkCommands: string[],
  database = getDb(),
): Promise<RepositoryConnection | null> {
  if ((await getMembershipRole(sessionId, userId, database)) !== "owner") return null;
  const existing = await database
    .prepare("SELECT id, connected_at AS connectedAt FROM repository_connections WHERE session_id = ?")
    .bind(sessionId)
    .first<{ id: string; connectedAt: number }>();
  const connectionId = existing?.id ?? crypto.randomUUID();
  const now = Date.now();
  const statements = [
    database
      .prepare(
        `INSERT INTO repository_connections (
           id, session_id, installation_id, repository_id, repository_node_id,
           repository_owner, repository_name, repository_full_name, repository_private,
           default_branch, base_branch, status, connected_by, connected_at, updated_at, disconnected_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?, ?, ?, NULL)
         ON CONFLICT(session_id) DO UPDATE SET
           installation_id = excluded.installation_id,
           repository_id = excluded.repository_id,
           repository_node_id = excluded.repository_node_id,
           repository_owner = excluded.repository_owner,
           repository_name = excluded.repository_name,
           repository_full_name = excluded.repository_full_name,
           repository_private = excluded.repository_private,
           default_branch = excluded.default_branch,
           base_branch = excluded.base_branch,
           status = 'connected',
           connected_by = excluded.connected_by,
           updated_at = excluded.updated_at,
           disconnected_at = NULL`,
      )
      .bind(
        connectionId, sessionId, installationId, repository.id, repository.nodeId,
        repository.owner, repository.name, repository.fullName, repository.private ? 1 : 0,
        repository.defaultBranch, baseBranch, userId, existing?.connectedAt ?? now, now,
      ),
    database.prepare("DELETE FROM repository_check_commands WHERE connection_id = ?").bind(connectionId),
    ...checkCommands.map((command, position) => database
      .prepare(
        `INSERT INTO repository_check_commands (id, connection_id, position, command, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), connectionId, position, command, now, now)),
    database.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").bind(now, sessionId),
  ];
  if (stateId) {
    statements.push(
      database
        .prepare("UPDATE github_connection_states SET configured_at = ? WHERE id = ? AND session_id = ? AND user_id = ?")
        .bind(now, stateId, sessionId, userId),
    );
  }
  await database.batch(statements);
  return getRepositoryConnectionForMember(sessionId, userId, database);
}

export async function disconnectRepository(
  sessionId: string,
  userId: string,
  database = getDb(),
): Promise<RepositoryConnection | null> {
  if ((await getMembershipRole(sessionId, userId, database)) !== "owner") return null;
  const now = Date.now();
  const result = await database
    .prepare(
      `UPDATE repository_connections SET status = 'disconnected', disconnected_at = ?, updated_at = ?
       WHERE session_id = ? AND status = 'connected'`,
    )
    .bind(now, now, sessionId)
    .run();
  if (!result.success || Number(result.meta?.changes ?? 0) !== 1) return null;
  return getRepositoryConnectionForMember(sessionId, userId, database);
}

export async function getRepositoryConnectionRecord(
  sessionId: string,
  database: D1DatabaseLike,
): Promise<{ installationId: string; repositoryId: string } | null> {
  return database
    .prepare("SELECT installation_id AS installationId, repository_id AS repositoryId FROM repository_connections WHERE session_id = ?")
    .bind(sessionId)
    .first<{ installationId: string; repositoryId: string }>();
}
