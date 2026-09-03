import type { GitHubRepositoryOption, RepositoryCandidate, RepositoryConnection, RepositoryConnectionStatus } from "@/lib/session-types";
import type { GitHubPullRequestReview } from "@/lib/github";
import { getDb, type D1DatabaseLike } from "./index";
import { getActiveMembershipRole, getMembershipRole } from "./sessions";

type RepositoryConnectionRecord = Omit<RepositoryConnection, "repositoryPrivate"> & {
  repositoryPrivate: number | boolean;
};

export async function createGitHubConnectionState(
  sessionId: string,
  userId: string,
  database = getDb(),
): Promise<string | null> {
  if ((await getActiveMembershipRole(sessionId, userId, database)) !== "owner") return null;
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
           SELECT 1 FROM session_members sm JOIN sessions s ON s.id = sm.session_id
           WHERE sm.session_id = github_connection_states.session_id
             AND sm.user_id = ? AND sm.role = 'owner' AND sm.removed_at IS NULL AND s.ended_at IS NULL
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
  if ((await getActiveMembershipRole(sessionId, userId, database)) !== "owner") return null;
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
  return { ...record, repositoryPrivate: Boolean(record.repositoryPrivate) };
}

export async function saveRepositoryConnection(
  sessionId: string,
  userId: string,
  stateId: string | null,
  installationId: string,
  repository: GitHubRepositoryOption,
  baseBranch: string,
  database = getDb(),
): Promise<RepositoryConnection | null> {
  if ((await getActiveMembershipRole(sessionId, userId, database)) !== "owner") return null;
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
  if ((await getActiveMembershipRole(sessionId, userId, database)) !== "owner") return null;
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

type CandidateRecord = Omit<RepositoryCandidate, "behindBase" | "pullRequestDraft" | "pullRequestMerged" | "pullRequestMergeable" | "githubChecksPassing"> & {
  pullRequestDraft: number | boolean | null;
  pullRequestMerged: number | boolean | null;
  pullRequestMergeable: number | boolean | null;
  githubChecksPassing: number | boolean | null;
};

function mapCandidate(record: CandidateRecord): RepositoryCandidate {
  return {
    ...record,
    // mergedAt wins if somehow both are set (abandon only ever applies to a
    // still-live candidate, so this ordering is defensive, not reachable).
    status: record.mergedAt ? "merged" : record.abandonedAt ? "abandoned" : record.status,
    pullRequestDraft: record.pullRequestDraft == null ? null : Boolean(record.pullRequestDraft),
    pullRequestMerged: record.pullRequestMerged == null ? null : Boolean(record.pullRequestMerged),
    pullRequestMergeable: record.pullRequestMergeable == null ? null : Boolean(record.pullRequestMergeable),
    githubChecksPassing: record.githubChecksPassing == null ? null : Boolean(record.githubChecksPassing),
    behindBase: Boolean(record.remoteBaseSha && record.remoteBaseSha !== record.baseSha),
  };
}

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
    `SELECT id, session_id AS sessionId, connection_id AS connectionId, name, description, branch_name AS branchName,
            base_branch AS baseBranch, base_sha AS baseSha, candidate_sha AS candidateSha,
            remote_base_sha AS remoteBaseSha, remote_candidate_sha AS remoteCandidateSha,
            integration_run_id AS integrationRunId, pull_request_number AS pullRequestNumber,
            pull_request_node_id AS pullRequestNodeId, pull_request_url AS pullRequestUrl,
            pull_request_state AS pullRequestState, pull_request_draft AS pullRequestDraft,
            pull_request_merged AS pullRequestMerged, pull_request_mergeable AS pullRequestMergeable,
            pull_request_mergeable_state AS pullRequestMergeableState, github_checks_passing AS githubChecksPassing,
            review_ready_at AS reviewReadyAt, review_synced_at AS reviewSyncedAt, merge_locked_at AS mergeLockedAt,
            merge_commit_sha AS mergeCommitSha, merged_at AS mergedAt, cleanup_status AS cleanupStatus,
            cleanup_completed_at AS cleanupCompletedAt, branch_deleted_at AS branchDeletedAt, abandoned_at AS abandonedAt,
            status, created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt,
            last_synced_at AS lastSyncedAt
     FROM repository_candidates WHERE session_id = ? AND status IN ('creating', 'active') AND merged_at IS NULL AND abandoned_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(sessionId).first<CandidateRecord>();
  return record ? mapCandidate(record) : null;
}

// Latest candidate regardless of live/merged/abandoned state — Review keeps
// showing an abandoned or merged candidate's history, it just stops being
// the *live* one returned by getActiveRepositoryCandidate above.
export async function getLatestRepositoryReviewCandidate(sessionId: string, database: D1DatabaseLike): Promise<RepositoryCandidate | null> {
  const record = await database.prepare(
    `SELECT id, session_id AS sessionId, connection_id AS connectionId, name, description, branch_name AS branchName,
            base_branch AS baseBranch, base_sha AS baseSha, candidate_sha AS candidateSha,
            remote_base_sha AS remoteBaseSha, remote_candidate_sha AS remoteCandidateSha,
            integration_run_id AS integrationRunId, pull_request_number AS pullRequestNumber,
            pull_request_node_id AS pullRequestNodeId, pull_request_url AS pullRequestUrl,
            pull_request_state AS pullRequestState, pull_request_draft AS pullRequestDraft,
            pull_request_merged AS pullRequestMerged, pull_request_mergeable AS pullRequestMergeable,
            pull_request_mergeable_state AS pullRequestMergeableState, github_checks_passing AS githubChecksPassing,
            review_ready_at AS reviewReadyAt, review_synced_at AS reviewSyncedAt, merge_locked_at AS mergeLockedAt,
            merge_commit_sha AS mergeCommitSha, merged_at AS mergedAt, cleanup_status AS cleanupStatus,
            cleanup_completed_at AS cleanupCompletedAt, branch_deleted_at AS branchDeletedAt, abandoned_at AS abandonedAt,
            status, created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt,
            last_synced_at AS lastSyncedAt
     FROM repository_candidates WHERE session_id = ? AND status = 'active'
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(sessionId).first<CandidateRecord>();
  return record ? mapCandidate(record) : null;
}

export async function getRepositoryCandidateReviewData(candidateId: string, database: D1DatabaseLike) {
  const [files, checks] = await Promise.all([
    database.prepare(
      `SELECT id, path, additions, deletions, change_kind AS changeKind, patch_preview AS patchPreview
       FROM repository_candidate_files WHERE candidate_id = ? ORDER BY path`,
    ).bind(candidateId).all<{ id: string; path: string; additions: number; deletions: number; changeKind: "add" | "update" | "delete"; patchPreview: string }>(),
    database.prepare(
      `SELECT id, source_id AS sourceId, name, detail, state
       FROM repository_candidate_checks WHERE candidate_id = ? ORDER BY name, source_id`,
    ).bind(candidateId).all<{ id: string; sourceId: string; name: string; detail: string | null; state: "passed" | "waiting" | "failed" }>(),
  ]);
  return { files: files.results, checks: checks.results };
}

export async function reserveRepositoryCandidate(
  sessionId: string,
  userId: string,
  connectionId: string,
  candidateId: string,
  name: string,
  description: string,
  branchName: string,
  baseBranch: string,
  baseSha: string,
  database = getDb(),
): Promise<boolean> {
  if ((await getActiveMembershipRole(sessionId, userId, database)) !== "owner") return false;
  const now = Date.now();
  try {
    const result = await database.prepare(
      `INSERT INTO repository_candidates
       (id, session_id, connection_id, name, description, branch_name, base_branch, base_sha, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?)`,
    ).bind(candidateId, sessionId, connectionId, name, description, branchName, baseBranch, baseSha, userId, now, now).run();
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

export async function getLatestFailedRepositoryCandidateForOwner(
  sessionId: string,
  userId: string,
  database = getDb(),
): Promise<Pick<RepositoryCandidate, "id" | "connectionId" | "name" | "description" | "branchName" | "baseBranch" | "baseSha"> | null> {
  if ((await getActiveMembershipRole(sessionId, userId, database)) !== "owner") return null;
  return database.prepare(
    `SELECT id, connection_id AS connectionId, name, description, branch_name AS branchName,
            base_branch AS baseBranch, base_sha AS baseSha
     FROM repository_candidates
     WHERE session_id = ? AND status = 'creation_failed' AND merged_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(sessionId).first<Pick<RepositoryCandidate, "id" | "connectionId" | "name" | "description" | "branchName" | "baseBranch" | "baseSha">>();
}

export async function reactivateFailedRepositoryCandidate(
  sessionId: string,
  candidateId: string,
  database = getDb(),
): Promise<boolean> {
  const result = await database.prepare(
    `UPDATE repository_candidates SET status = 'creating', updated_at = ?
     WHERE id = ? AND session_id = ? AND status = 'creation_failed'
       AND NOT EXISTS (
         SELECT 1 FROM repository_candidates active
         WHERE active.session_id = ? AND active.status IN ('creating', 'active') AND active.merged_at IS NULL
       )`,
  ).bind(Date.now(), candidateId, sessionId, sessionId).run();
  return result.success && Number(result.meta?.changes ?? 0) === 1;
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
       WHERE session_id = ? AND status = 'active' AND merged_at IS NULL AND abandoned_at IS NULL`,
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

// A delivery row is a completed-processing marker, not permission to lose a
// signed event. The route claims before applying effects to exclude concurrent
// replays, then removes the claim if any effect fails so GitHub's manual
// redelivery can apply the same delivery ID again.
export async function releaseGitHubWebhookDelivery(
  deliveryId: string,
  database = getDb(),
): Promise<void> {
  await database.prepare("DELETE FROM github_webhook_deliveries WHERE delivery_id = ?")
    .bind(deliveryId).run();
}

export async function findRepositoryWebhookTargets(
  installationId: string | null,
  repositoryId: string | null,
  database = getDb(),
): Promise<Array<{
  sessionId: string; repositoryId: string; baseBranch: string; candidateBranch: string | null; candidateSha: string | null;
  remoteCandidateSha: string | null; integrationRunId: string | null; pullRequestNumber: number | null; pullRequestNodeId: string | null;
}>> {
  if (!installationId) return [];
  const result = await database.prepare(
    `SELECT rc.session_id AS sessionId, rc.repository_id AS repositoryId, rc.base_branch AS baseBranch,
            c.branch_name AS candidateBranch, c.candidate_sha AS candidateSha, c.remote_candidate_sha AS remoteCandidateSha,
            c.integration_run_id AS integrationRunId,
            c.pull_request_number AS pullRequestNumber, c.pull_request_node_id AS pullRequestNodeId
     FROM repository_connections rc
     LEFT JOIN repository_candidates c ON c.session_id = rc.session_id AND c.status = 'active' AND c.merged_at IS NULL AND c.abandoned_at IS NULL
     WHERE rc.installation_id = ? AND rc.status != 'disconnected' AND (? IS NULL OR rc.repository_id = ?)`,
  ).bind(installationId, repositoryId, repositoryId).all<{
    sessionId: string; repositoryId: string; baseBranch: string; candidateBranch: string | null; candidateSha: string | null;
    remoteCandidateSha: string | null; integrationRunId: string | null; pullRequestNumber: number | null; pullRequestNodeId: string | null;
  }>();
  return result.results.map((row) => ({ ...row, pullRequestNumber: row.pullRequestNumber === null ? null : Number(row.pullRequestNumber) }));
}

export async function updateRepositoryPushState(
  sessionId: string,
  ref: string,
  after: string,
  baseBranch: string,
  candidateBranch: string | null,
  candidateSha: string | null,
  integrationRunId: string | null,
  database = getDb(),
): Promise<number> {
  const now = Date.now();
  const statements = [database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?").bind(now, sessionId)];
  if (ref === `refs/heads/${baseBranch}`) {
    statements.push(database.prepare("UPDATE repository_candidates SET remote_base_sha = ?, last_synced_at = ?, updated_at = ? WHERE session_id = ? AND status = 'active' AND merged_at IS NULL AND abandoned_at IS NULL").bind(after, now, now, sessionId));
  }
  if (candidateBranch && ref === `refs/heads/${candidateBranch}`) {
    statements.push(database.prepare("UPDATE repository_candidates SET remote_candidate_sha = ?, last_synced_at = ?, updated_at = ? WHERE session_id = ? AND status = 'active' AND merged_at IS NULL AND abandoned_at IS NULL").bind(after, now, now, sessionId));
    if (after !== candidateSha && !integrationRunId) statements.push(database.prepare("UPDATE repository_connections SET status = 'externally_modified', updated_at = ? WHERE session_id = ?").bind(now, sessionId));
  }
  if (ref.startsWith("refs/heads/openfloor/")) {
    statements.push(database.prepare(
      "UPDATE agent_runs SET remote_run_sha = ?, updated_at = ? WHERE session_id = ? AND run_branch = ? AND status = 'published'",
    ).bind(after, now, sessionId, ref.slice("refs/heads/".length)));
  }
  await database.batch(statements);
  return getFloorRevision(sessionId, database);
}

export async function updateRepositoryPullRequestState(
  sessionId: string,
  pullRequest: { number: number; nodeId: string; url: string; state: "open" | "closed"; draft: boolean; merged: boolean; mergeCommitSha: string | null; headRef: string },
  database = getDb(),
): Promise<number> {
  const now = Date.now();
  await database.batch([
    database.prepare(
      `UPDATE repository_candidates SET pull_request_number = ?, pull_request_node_id = ?, pull_request_url = ?,
              pull_request_state = ?, pull_request_draft = ?, pull_request_merged = ?,
              merge_commit_sha = COALESCE(?, merge_commit_sha),
              merged_at = CASE WHEN ? THEN COALESCE(merged_at, ?) ELSE merged_at END,
              cleanup_status = CASE WHEN ? THEN COALESCE(cleanup_status, 'pending') ELSE cleanup_status END,
              updated_at = ?
       WHERE session_id = ? AND status = 'active' AND abandoned_at IS NULL AND branch_name = ?`,
    ).bind(pullRequest.number, pullRequest.nodeId, pullRequest.url, pullRequest.state, pullRequest.draft ? 1 : 0,
      pullRequest.merged ? 1 : 0, pullRequest.mergeCommitSha, pullRequest.merged ? 1 : 0, now,
      pullRequest.merged ? 1 : 0, now, sessionId, pullRequest.headRef),
    database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?").bind(now, sessionId),
  ]);
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

export async function getCandidateReviewMutationContext(
  sessionId: string,
  userId: string,
  database = getDb(),
) {
  if ((await getActiveMembershipRole(sessionId, userId, database)) !== "owner") return null;
  const candidate = await database.prepare(
    `SELECT c.id AS candidateId, c.branch_name AS candidateBranch, c.base_branch AS baseBranch,
            c.candidate_sha AS candidateSha, c.remote_candidate_sha AS remoteCandidateSha,
            c.integration_run_id AS integrationRunId, c.merge_locked_at AS mergeLockedAt,
            c.pull_request_number AS pullRequestNumber, c.pull_request_node_id AS pullRequestNodeId,
            c.pull_request_draft AS pullRequestDraft, CASE WHEN c.merged_at IS NOT NULL THEN 'merged' ELSE c.status END AS candidateStatus,
            rc.status AS connectionStatus, rc.installation_id AS installationId,
            rc.repository_id AS repositoryId, rc.repository_owner AS repositoryOwner,
            rc.repository_name AS repositoryName, rc.repository_full_name AS repositoryFullName,
            rc.repository_private AS repositoryPrivate, rc.default_branch AS defaultBranch
     FROM repository_candidates c JOIN repository_connections rc ON rc.id = c.connection_id
     WHERE c.session_id = ? AND c.status = 'active' AND c.abandoned_at IS NULL ORDER BY c.created_at DESC LIMIT 1`,
  ).bind(sessionId).first<{
    candidateId: string; candidateBranch: string; baseBranch: string; candidateSha: string | null; remoteCandidateSha: string | null;
    integrationRunId: string | null; mergeLockedAt: number | null;
    pullRequestNumber: number | null; pullRequestNodeId: string | null; pullRequestDraft: number | boolean | null;
    candidateStatus: "active" | "merged"; connectionStatus: RepositoryConnectionStatus; installationId: string;
    repositoryId: string; repositoryOwner: string; repositoryName: string; repositoryFullName: string;
    repositoryPrivate: number | boolean; defaultBranch: string;
  }>();
  if (!candidate) return null;
  const runs = await database.prepare(
    `SELECT id, run_branch AS branchName, run_commit_sha AS expectedSha, remote_run_sha AS remoteSha,
            branch_deleted_at AS branchDeletedAt
     FROM agent_runs WHERE candidate_id = ? AND status IN ('published', 'integrated', 'conflicted')
       AND discarded_at IS NULL AND run_branch IS NOT NULL AND run_commit_sha IS NOT NULL
     ORDER BY created_at`,
  ).bind(candidate.candidateId).all<{ id: string; branchName: string; expectedSha: string; remoteSha: string | null; branchDeletedAt: number | null }>();
  return { ...candidate, repositoryPrivate: Boolean(candidate.repositoryPrivate), runs: runs.results };
}

/* Review synchronization context available to all active session members,
   not just the session owner. Review data is member-visible read-only state. */
export async function getCandidateReviewSyncContext(
  sessionId: string,
  userId: string,
  database = getDb(),
) {
  if (!(await getActiveMembershipRole(sessionId, userId, database))) return null;
  const candidate = await database.prepare(
    `SELECT c.id AS candidateId, c.branch_name AS candidateBranch, c.base_branch AS baseBranch,
            c.candidate_sha AS candidateSha, c.remote_candidate_sha AS remoteCandidateSha,
            c.integration_run_id AS integrationRunId,
            c.pull_request_number AS pullRequestNumber, c.pull_request_node_id AS pullRequestNodeId,
            c.pull_request_draft AS pullRequestDraft, CASE WHEN c.merged_at IS NOT NULL THEN 'merged' ELSE c.status END AS candidateStatus,
            rc.status AS connectionStatus, rc.installation_id AS installationId,
            rc.repository_id AS repositoryId, rc.repository_owner AS repositoryOwner,
            rc.repository_name AS repositoryName, rc.repository_full_name AS repositoryFullName,
            rc.repository_private AS repositoryPrivate, rc.default_branch AS defaultBranch
     FROM repository_candidates c JOIN repository_connections rc ON rc.id = c.connection_id
     WHERE c.session_id = ? AND c.status = 'active' AND c.abandoned_at IS NULL ORDER BY c.created_at DESC LIMIT 1`,
  ).bind(sessionId).first<{
    candidateId: string; candidateBranch: string; baseBranch: string; candidateSha: string | null; remoteCandidateSha: string | null;
    integrationRunId: string | null;
    pullRequestNumber: number | null; pullRequestNodeId: string | null; pullRequestDraft: number | boolean | null;
    candidateStatus: "active" | "merged"; connectionStatus: RepositoryConnectionStatus; installationId: string;
    repositoryId: string; repositoryOwner: string; repositoryName: string; repositoryFullName: string;
    repositoryPrivate: number | boolean; defaultBranch: string;
  }>();
  if (!candidate) return null;
  return { ...candidate, repositoryPrivate: Boolean(candidate.repositoryPrivate) };
}

/* Shared by the deferred post-merge "delete candidate branch" action and
   candidate abandonment (lib/candidate-abandon.ts) — both need the latest
   candidate's branch/SHA/lease state plus its still-live run branches, for
   an owner, working post-end the same way endSession/deleteSession do.
   Deliberately getMembershipRole, not the active guard. */
export async function getCandidateBranchDeleteContext(
  sessionId: string,
  userId: string,
  database = getDb(),
) {
  if ((await getMembershipRole(sessionId, userId, database)) !== "owner") return null;
  const candidate = await database.prepare(
    `SELECT c.id AS candidateId, c.branch_name AS candidateBranch, c.candidate_sha AS candidateSha,
            c.merged_at AS mergedAt, c.branch_deleted_at AS branchDeletedAt, c.integration_run_id AS integrationRunId,
            c.abandoned_at AS abandonedAt,
            rc.installation_id AS installationId, rc.repository_id AS repositoryId,
            rc.repository_owner AS repositoryOwner, rc.repository_name AS repositoryName,
            rc.repository_full_name AS repositoryFullName, rc.repository_private AS repositoryPrivate,
            rc.default_branch AS defaultBranch
     FROM repository_candidates c JOIN repository_connections rc ON rc.id = c.connection_id
     WHERE c.session_id = ? ORDER BY c.created_at DESC LIMIT 1`,
  ).bind(sessionId).first<{
    candidateId: string; candidateBranch: string; candidateSha: string | null;
    mergedAt: number | null; branchDeletedAt: number | null; integrationRunId: string | null; abandonedAt: number | null;
    installationId: string; repositoryId: string; repositoryOwner: string; repositoryName: string;
    repositoryFullName: string; repositoryPrivate: number | boolean; defaultBranch: string;
  }>();
  if (!candidate) return null;
  const runs = await database.prepare(
    `SELECT id, run_branch AS branchName, run_commit_sha AS expectedSha, remote_run_sha AS remoteSha,
            branch_deleted_at AS branchDeletedAt
     FROM agent_runs WHERE candidate_id = ? AND status IN ('published', 'integrated', 'conflicted')
       AND discarded_at IS NULL AND run_branch IS NOT NULL AND run_commit_sha IS NOT NULL
     ORDER BY created_at`,
  ).bind(candidate.candidateId).all<{ id: string; branchName: string; expectedSha: string; remoteSha: string | null; branchDeletedAt: number | null }>();
  return { ...candidate, repositoryPrivate: Boolean(candidate.repositoryPrivate), runs: runs.results };
}

export async function reconcileCandidateReview(
  sessionId: string,
  candidateId: string,
  review: GitHubPullRequestReview,
  database = getDb(),
): Promise<number> {
  const now = Date.now();
  const statements = [
    database.prepare(
      `UPDATE repository_candidates SET pull_request_number = ?, pull_request_node_id = ?, pull_request_url = ?,
              pull_request_state = ?, pull_request_draft = ?, pull_request_merged = ?, pull_request_mergeable = ?,
              pull_request_mergeable_state = ?, github_checks_passing = ?, review_synced_at = ?, updated_at = ?
       WHERE id = ? AND session_id = ?`,
    ).bind(review.number, review.nodeId, review.url, review.state, review.draft ? 1 : 0, review.merged ? 1 : 0,
      review.mergeable == null ? null : review.mergeable ? 1 : 0, review.mergeableState, review.checksPassing ? 1 : 0,
      now, now, candidateId, sessionId),
    database.prepare("DELETE FROM repository_candidate_files WHERE candidate_id = ?").bind(candidateId),
    database.prepare("DELETE FROM repository_candidate_checks WHERE candidate_id = ?").bind(candidateId),
    ...review.files.map((file) => database.prepare(
      `INSERT INTO repository_candidate_files (id, candidate_id, path, additions, deletions, change_kind, patch_preview)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), candidateId, file.path, file.additions, file.deletions, file.changeKind, file.patchPreview)),
    ...review.checks.map((check) => database.prepare(
      `INSERT INTO repository_candidate_checks (id, candidate_id, source_id, name, detail, state)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), candidateId, check.sourceId, check.name, check.detail, check.state)),
    database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?").bind(now, sessionId),
  ];
  await database.batch(statements);
  return getFloorRevision(sessionId, database);
}

export async function markCandidateReviewReady(
  sessionId: string,
  candidateId: string,
  userId: string,
  database = getDb(),
): Promise<number> {
  const now = Date.now();
  await database.batch([
    database.prepare(
      `UPDATE repository_candidates SET review_ready_at = COALESCE(review_ready_at, ?), review_ready_by = ?,
              pull_request_draft = 0, updated_at = ? WHERE id = ? AND session_id = ? AND status = 'active' AND merged_at IS NULL AND abandoned_at IS NULL`,
    ).bind(now, userId, now, candidateId, sessionId),
    database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?").bind(now, sessionId),
  ]);
  return getFloorRevision(sessionId, database);
}

// Converting back to draft keeps review_ready_at/review_ready_by untouched:
// they audit the first time the candidate was marked ready, not its current state.
export async function markCandidateReviewDraft(
  sessionId: string,
  candidateId: string,
  database = getDb(),
): Promise<number> {
  const now = Date.now();
  await database.batch([
    database.prepare(
      `UPDATE repository_candidates SET pull_request_draft = 1, updated_at = ?
       WHERE id = ? AND session_id = ? AND status = 'active' AND merged_at IS NULL AND abandoned_at IS NULL`,
    ).bind(now, candidateId, sessionId),
    database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?").bind(now, sessionId),
  ]);
  return getFloorRevision(sessionId, database);
}

export async function setCandidateMergeLocked(
  sessionId: string,
  candidateId: string,
  locked: boolean,
  database = getDb(),
): Promise<number> {
  const now = Date.now();
  await database.batch([
    database.prepare(
      `UPDATE repository_candidates SET merge_locked_at = ?, updated_at = ?
       WHERE id = ? AND session_id = ? AND status = 'active' AND merged_at IS NULL AND abandoned_at IS NULL`,
    ).bind(locked ? now : null, now, candidateId, sessionId),
    database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?").bind(now, sessionId),
  ]);
  return getFloorRevision(sessionId, database);
}

export async function markCandidateMerged(
  sessionId: string,
  candidateId: string,
  userId: string,
  mergeCommitSha: string,
  database = getDb(),
): Promise<number> {
  const now = Date.now();
  await database.batch([
    database.prepare(
      `UPDATE repository_candidates SET pull_request_state = 'closed', pull_request_draft = 0,
              pull_request_merged = 1, merge_commit_sha = ?, merged_at = ?, merged_by = ?, cleanup_status = 'pending', updated_at = ?
       WHERE id = ? AND session_id = ? AND status = 'active' AND merged_at IS NULL AND abandoned_at IS NULL`,
    ).bind(mergeCommitSha, now, userId, now, candidateId, sessionId),
    database.prepare("UPDATE repository_connections SET status = 'ready', updated_at = ? WHERE session_id = ? AND status != 'disconnected'").bind(now, sessionId),
    database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?").bind(now, sessionId),
  ]);
  return getFloorRevision(sessionId, database);
}

/* Owner-initiated abandonment of a still-live candidate — see
   lib/candidate-abandon.ts. Idempotent no-op once the candidate has already
   left the live state (merged, already abandoned, or creation_failed): the
   WHERE clause mirrors idx_repository_candidates_one_live exactly, so a
   caller that races this against a merge always loses cleanly rather than
   double-writing. */
export async function markCandidateAbandoned(
  sessionId: string,
  candidateId: string,
  database = getDb(),
): Promise<number> {
  const now = Date.now();
  await database.batch([
    database.prepare(
      `UPDATE repository_candidates SET abandoned_at = ?, updated_at = ?
       WHERE id = ? AND session_id = ? AND status IN ('creating', 'active') AND merged_at IS NULL AND abandoned_at IS NULL`,
    ).bind(now, now, candidateId, sessionId),
    // Drop the connection back to 'connected' so a fresh candidate can be
    // reserved (repository/candidate route's POST guard requires exactly
    // that status) — abandonment always leaves the session without a live
    // candidate, so 'ready' (which means "has one") would otherwise be a
    // stale claim that blocks the next reservation.
    database.prepare("UPDATE repository_connections SET status = 'connected', updated_at = ? WHERE session_id = ? AND status = 'ready'").bind(now, sessionId),
    database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?").bind(now, sessionId),
  ]);
  return getFloorRevision(sessionId, database);
}

export async function finishCandidateCleanup(
  sessionId: string,
  candidateId: string,
  deletedRunIds: string[],
  candidateDeleted: boolean,
  complete: boolean,
  database = getDb(),
): Promise<number> {
  const now = Date.now();
  await database.batch([
    ...deletedRunIds.map((runId) => database.prepare("UPDATE agent_runs SET branch_deleted_at = ?, updated_at = ? WHERE id = ? AND candidate_id = ?").bind(now, now, runId, candidateId)),
    database.prepare(
      `UPDATE repository_candidates SET cleanup_status = ?, cleanup_completed_at = ?,
              branch_deleted_at = CASE WHEN ? THEN ? ELSE branch_deleted_at END, updated_at = ?
       WHERE id = ? AND session_id = ? AND (merged_at IS NOT NULL OR abandoned_at IS NOT NULL)`,
    ).bind(complete ? "complete" : "partial", now, candidateDeleted ? 1 : 0, now, now, candidateId, sessionId),
    database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?").bind(now, sessionId),
  ]);
  return getFloorRevision(sessionId, database);
}

async function getFloorRevision(sessionId: string, database: D1DatabaseLike): Promise<number> {
  const row = await database.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?").bind(sessionId).first<{ revision: number }>();
  return Number(row?.revision ?? 0);
}

export async function getRepositoryFloorRevision(sessionId: string, database = getDb()): Promise<number> {
  return getFloorRevision(sessionId, database);
}
