import type { GitHubRepositoryOption, RepositoryCandidate, RepositoryConnection, RepositoryConnectionStatus, RepositoryCheckCommand } from "@/lib/session-types";
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
           status = CASE WHEN repository_connections.status IN ('ready', 'externally_modified') THEN repository_connections.status ELSE 'connected' END,
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
    database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?").bind(now, sessionId),
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
  const existing = await database.prepare("SELECT id FROM repository_connections WHERE session_id = ? AND status != 'disconnected'").bind(sessionId).first();
  if (!existing) return null;
  await database.batch([
    database.prepare(
      `UPDATE repository_connections SET status = 'disconnected', disconnected_at = ?, updated_at = ?
       WHERE session_id = ? AND status != 'disconnected'`,
    ).bind(now, now, sessionId),
    database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?").bind(now, sessionId),
  ]);
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

type CandidateRecord = Omit<RepositoryCandidate, "behindBase">;

export async function getActiveRepositoryCandidateForMember(
  sessionId: string,
  userId: string,
  database = getDb(),
): Promise<RepositoryCandidate | null> {
  if (!(await getMembershipRole(sessionId, userId, database))) return null;
  return getActiveRepositoryCandidate(sessionId, database);
}

export async function getActiveRepositoryCandidate(
  sessionId: string,
  database: D1DatabaseLike,
): Promise<RepositoryCandidate | null> {
  const record = await database.prepare(
    `SELECT id, session_id AS sessionId, connection_id AS connectionId, branch_name AS branchName,
            base_branch AS baseBranch, base_sha AS baseSha, candidate_sha AS candidateSha,
            remote_base_sha AS remoteBaseSha, remote_candidate_sha AS remoteCandidateSha,
            status, created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt,
            last_synced_at AS lastSyncedAt
     FROM repository_candidates WHERE session_id = ? AND status IN ('creating', 'active')
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(sessionId).first<CandidateRecord>();
  return record ? { ...record, behindBase: Boolean(record.remoteBaseSha && record.remoteBaseSha !== record.baseSha) } : null;
}

export async function reserveRepositoryCandidate(
  sessionId: string,
  userId: string,
  connectionId: string,
  candidateId: string,
  branchName: string,
  baseBranch: string,
  baseSha: string,
  database = getDb(),
): Promise<boolean> {
  if ((await getMembershipRole(sessionId, userId, database)) !== "owner") return false;
  const now = Date.now();
  try {
    const result = await database.prepare(
      `INSERT INTO repository_candidates
       (id, session_id, connection_id, branch_name, base_branch, base_sha, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?)`,
    ).bind(candidateId, sessionId, connectionId, branchName, baseBranch, baseSha, userId, now, now).run();
    return result.success;
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) return false;
    throw error;
  }
}

export async function activateRepositoryCandidate(
  sessionId: string,
  candidateId: string,
  sha: string,
  database = getDb(),
): Promise<number> {
  const now = Date.now();
  await database.batch([
    database.prepare(
      `UPDATE repository_candidates SET status = 'active', candidate_sha = ?, remote_base_sha = ?,
              remote_candidate_sha = ?, last_synced_at = ?, updated_at = ?
       WHERE id = ? AND session_id = ? AND status = 'creating'`,
    ).bind(sha, sha, sha, now, now, candidateId, sessionId),
    database.prepare("UPDATE repository_connections SET status = 'ready', updated_at = ? WHERE session_id = ?").bind(now, sessionId),
    database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?").bind(now, sessionId),
  ]);
  return getFloorRevision(sessionId, database);
}

export async function failRepositoryCandidate(candidateId: string, database = getDb()): Promise<void> {
  await database.prepare("UPDATE repository_candidates SET status = 'creation_failed', updated_at = ? WHERE id = ? AND status = 'creating'")
    .bind(Date.now(), candidateId).run();
}

export async function reconcileRepositoryCandidate(
  sessionId: string,
  metadata: GitHubRepositoryOption,
  remoteBaseSha: string,
  remoteCandidateSha: string,
  status: RepositoryConnectionStatus,
  database = getDb(),
): Promise<number> {
  const now = Date.now();
  await database.batch([
    database.prepare(
      `UPDATE repository_connections SET repository_owner = ?, repository_name = ?, repository_full_name = ?,
              repository_private = ?, default_branch = ?, status = ?, updated_at = ? WHERE session_id = ?`,
    ).bind(metadata.owner, metadata.name, metadata.fullName, metadata.private ? 1 : 0, metadata.defaultBranch, status, now, sessionId),
    database.prepare(
      `UPDATE repository_candidates SET remote_base_sha = ?, remote_candidate_sha = ?, last_synced_at = ?, updated_at = ?
       WHERE session_id = ? AND status = 'active'`,
    ).bind(remoteBaseSha, remoteCandidateSha, now, now, sessionId),
    database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?").bind(now, sessionId),
  ]);
  return getFloorRevision(sessionId, database);
}

export async function setRepositoryAvailability(
  sessionId: string,
  status: Extract<RepositoryConnectionStatus, "revoked" | "inaccessible" | "connected" | "externally_modified">,
  database = getDb(),
): Promise<number> {
  const now = Date.now();
  await database.batch([
    database.prepare("UPDATE repository_connections SET status = ?, updated_at = ? WHERE session_id = ? AND status != 'disconnected'").bind(status, now, sessionId),
    database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?").bind(now, sessionId),
  ]);
  return getFloorRevision(sessionId, database);
}

export async function recordGitHubWebhookDelivery(
  deliveryId: string,
  event: string,
  action: string | null,
  installationId: string | null,
  repositoryId: string | null,
  database = getDb(),
): Promise<boolean> {
  const result = await database.prepare(
    `INSERT OR IGNORE INTO github_webhook_deliveries
     (delivery_id, event, action, installation_id, repository_id, received_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(deliveryId, event, action, installationId, repositoryId, Date.now()).run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function findRepositoryWebhookTargets(
  installationId: string | null,
  repositoryId: string | null,
  database = getDb(),
): Promise<Array<{ sessionId: string; repositoryId: string; baseBranch: string; candidateBranch: string | null; candidateSha: string | null }>> {
  if (!installationId) return [];
  const result = await database.prepare(
    `SELECT rc.session_id AS sessionId, rc.repository_id AS repositoryId, rc.base_branch AS baseBranch,
            c.branch_name AS candidateBranch, c.candidate_sha AS candidateSha
     FROM repository_connections rc
     LEFT JOIN repository_candidates c ON c.session_id = rc.session_id AND c.status = 'active'
     WHERE rc.installation_id = ? AND rc.status != 'disconnected' AND (? IS NULL OR rc.repository_id = ?)`,
  ).bind(installationId, repositoryId, repositoryId).all<{ sessionId: string; repositoryId: string; baseBranch: string; candidateBranch: string | null; candidateSha: string | null }>();
  return result.results;
}

export async function updateRepositoryPushState(
  sessionId: string,
  ref: string,
  after: string,
  baseBranch: string,
  candidateBranch: string | null,
  candidateSha: string | null,
  database = getDb(),
): Promise<number> {
  const now = Date.now();
  const statements = [database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?").bind(now, sessionId)];
  if (ref === `refs/heads/${baseBranch}`) {
    statements.push(database.prepare("UPDATE repository_candidates SET remote_base_sha = ?, last_synced_at = ?, updated_at = ? WHERE session_id = ? AND status = 'active'").bind(after, now, now, sessionId));
  }
  if (candidateBranch && ref === `refs/heads/${candidateBranch}`) {
    statements.push(database.prepare("UPDATE repository_candidates SET remote_candidate_sha = ?, last_synced_at = ?, updated_at = ? WHERE session_id = ? AND status = 'active'").bind(after, now, now, sessionId));
    if (after !== candidateSha) statements.push(database.prepare("UPDATE repository_connections SET status = 'externally_modified', updated_at = ? WHERE session_id = ?").bind(now, sessionId));
  }
  if (ref.startsWith("refs/heads/openfloor/")) {
    statements.push(database.prepare(
      "UPDATE agent_runs SET remote_run_sha = ?, updated_at = ? WHERE session_id = ? AND run_branch = ? AND status = 'published'",
    ).bind(after, now, sessionId, ref.slice("refs/heads/".length)));
  }
  await database.batch(statements);
  return getFloorRevision(sessionId, database);
}

export async function updateRepositoryIdentity(
  sessionId: string,
  repository: { owner: string; name: string; fullName: string },
  database = getDb(),
): Promise<number> {
  const now = Date.now();
  await database.batch([
    database.prepare(
      "UPDATE repository_connections SET repository_owner = ?, repository_name = ?, repository_full_name = ?, updated_at = ? WHERE session_id = ?",
    ).bind(repository.owner, repository.name, repository.fullName, now, sessionId),
    database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?").bind(now, sessionId),
  ]);
  return getFloorRevision(sessionId, database);
}

export async function touchRepositoryReview(sessionId: string, database = getDb()): Promise<number> {
  const now = Date.now();
  await database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?").bind(now, sessionId).run();
  return getFloorRevision(sessionId, database);
}

async function getFloorRevision(sessionId: string, database: D1DatabaseLike): Promise<number> {
  const row = await database.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?").bind(sessionId).first<{ revision: number }>();
  return Number(row?.revision ?? 0);
}

export async function getRepositoryFloorRevision(sessionId: string, database = getDb()): Promise<number> {
  return getFloorRevision(sessionId, database);
}
