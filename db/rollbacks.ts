import type { AgentRunRollbackStatus } from "@/lib/floor-types";
import { getDb } from "./index";
import { AgentRunConflictError, AgentRunNotReadyError, appendRunEvent } from "./runs";
import { getActiveMembershipRole } from "./sessions";

export type AgentRunRollbackContext = {
  id: string;
  runId: string;
  sessionId: string;
  candidateId: string;
  expectedCandidateSha: string;
  targetCommitSha: string;
  status: AgentRunRollbackStatus;
  createdAt: number;
  candidateBranch: string;
  baseBranch: string;
  installationId: string;
  repositoryId: string;
  repositoryOwner: string;
  repositoryName: string;
  repositoryFullName: string;
  repositoryPrivate: boolean;
  defaultBranch: string;
  commands: string[];
};

export async function createAgentRunRollback(
  sessionId: string,
  runId: string,
  userId: string,
  database = getDb(),
): Promise<{ rollbackId: string; revision: number } | null> {
  const role = await getActiveMembershipRole(sessionId, userId, database);
  if (!role) return null;
  const context = await database.prepare(
    `SELECT r.id, r.status, r.integrated_candidate_sha AS integratedCandidateSha,
            r.queue_item_id AS queueItemId, a.owner_user_id AS agentOwnerUserId,
            c.id AS candidateId, c.status AS candidateStatus, c.candidate_sha AS candidateSha,
            c.remote_candidate_sha AS remoteCandidateSha, c.integration_run_id AS integrationRunId,
            c.merged_at AS mergedAt, rc.status AS connectionStatus,
            (SELECT COUNT(*) FROM floor_queue_prompts p WHERE p.queue_item_id = r.queue_item_id) AS promptCount,
            (SELECT COUNT(*) FROM floor_queue_prompts p WHERE p.queue_item_id = r.queue_item_id AND p.author_user_id != ?) AS otherAuthorCount,
            (SELECT COUNT(*) FROM agent_run_rollbacks completed WHERE completed.run_id = r.id AND completed.status = 'completed') AS completedCount,
            (SELECT COUNT(*) FROM agent_run_rollbacks active WHERE active.run_id = r.id AND active.status IN ('requested', 'running')) AS activeCount
     FROM agent_runs r
     JOIN floor_agents a ON a.id = r.agent_id
     JOIN repository_candidates c ON c.id = r.candidate_id
     JOIN repository_connections rc ON rc.id = c.connection_id
     WHERE r.id = ? AND r.session_id = ?`,
  ).bind(userId, runId, sessionId).first<{
    id: string; status: string; integratedCandidateSha: string | null; queueItemId: string; agentOwnerUserId: string;
    candidateId: string; candidateStatus: string; candidateSha: string | null; remoteCandidateSha: string | null;
    integrationRunId: string | null; mergedAt: number | null; connectionStatus: string;
    promptCount: number; otherAuthorCount: number; completedCount: number; activeCount: number;
  }>();
  if (!context) return null;
  const ownsEveryPrompt = Number(context.promptCount) > 0 && Number(context.otherAuthorCount) === 0;
  if (role !== "owner" && context.agentOwnerUserId !== userId && !ownsEveryPrompt) return null;
  if (context.status !== "integrated" || !context.integratedCandidateSha) {
    throw new AgentRunNotReadyError("Only an integrated prompt can be rolled back");
  }
  if (Number(context.completedCount) > 0) throw new AgentRunConflictError("This prompt was already rolled back");
  if (Number(context.activeCount) > 0) throw new AgentRunConflictError("This prompt is already being rolled back");
  if (context.candidateStatus !== "active" || context.mergedAt !== null) {
    throw new AgentRunConflictError("The candidate is no longer open for rollback");
  }
  if (context.connectionStatus !== "ready" || !context.candidateSha || context.remoteCandidateSha !== context.candidateSha) {
    throw new AgentRunConflictError("Synchronize the unchanged candidate before rolling back this prompt");
  }
  if (context.integrationRunId) throw new AgentRunConflictError("Another candidate update is already in progress");

  const now = Date.now();
  const claim = await database.prepare(
    `UPDATE repository_candidates SET integration_run_id = ?, updated_at = ?
     WHERE id = ? AND integration_run_id IS NULL AND candidate_sha = ? AND remote_candidate_sha = ?
       AND status = 'active' AND merged_at IS NULL
       AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND ended_at IS NULL)`,
  ).bind(runId, now, context.candidateId, context.candidateSha, context.candidateSha, sessionId).run();
  if (!claim.meta?.changes) throw new AgentRunConflictError("The candidate changed before rollback could start");

  const rollbackId = crypto.randomUUID();
  try {
    await database.batch([
      database.prepare(
        `INSERT INTO agent_run_rollbacks
         (id, run_id, session_id, candidate_id, expected_candidate_sha, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'requested', ?, ?, ?)`,
      ).bind(rollbackId, runId, sessionId, context.candidateId, context.candidateSha, userId, now, now),
      database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ? AND ended_at IS NULL")
        .bind(now, sessionId),
    ]);
  } catch (error) {
    await database.prepare("UPDATE repository_candidates SET integration_run_id = NULL, updated_at = ? WHERE id = ? AND integration_run_id = ?")
      .bind(Date.now(), context.candidateId, runId).run();
    throw error;
  }
  await appendRunEvent(runId, "rollback_requested", "Candidate rollback requested for this integrated prompt.", database);
  const revision = await database.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?")
    .bind(sessionId).first<{ revision: number }>();
  return { rollbackId, revision: Number(revision?.revision ?? 0) };
}

export async function beginAgentRunRollback(rollbackId: string, database = getDb()): Promise<AgentRunRollbackContext> {
  const row = await database.prepare(
    `SELECT rb.id, rb.run_id AS runId, rb.session_id AS sessionId, rb.candidate_id AS candidateId,
            rb.expected_candidate_sha AS expectedCandidateSha, rb.status, rb.created_at AS createdAt,
            r.integrated_candidate_sha AS targetCommitSha,
            c.branch_name AS candidateBranch, c.base_branch AS baseBranch, c.integration_run_id AS integrationRunId,
            rc.installation_id AS installationId, rc.repository_id AS repositoryId,
            rc.repository_owner AS repositoryOwner, rc.repository_name AS repositoryName,
            rc.repository_full_name AS repositoryFullName, rc.repository_private AS repositoryPrivate,
            rc.default_branch AS defaultBranch, rc.status AS connectionStatus,
            c.candidate_sha AS candidateSha, c.remote_candidate_sha AS remoteCandidateSha
     FROM agent_run_rollbacks rb
     JOIN agent_runs r ON r.id = rb.run_id AND r.status = 'integrated'
     JOIN repository_candidates c ON c.id = rb.candidate_id AND c.status = 'active' AND c.merged_at IS NULL
     JOIN repository_connections rc ON rc.id = c.connection_id
     WHERE rb.id = ?`,
  ).bind(rollbackId).first<Omit<AgentRunRollbackContext, "commands" | "repositoryPrivate"> & {
    integrationRunId: string | null; connectionStatus: string; candidateSha: string | null;
    remoteCandidateSha: string | null; repositoryPrivate: number;
  }>();
  if (!row || !["requested", "running"].includes(row.status) || !row.targetCommitSha) {
    throw new AgentRunConflictError("This rollback is no longer available");
  }
  if (row.integrationRunId !== row.runId || row.connectionStatus !== "ready" ||
      row.candidateSha !== row.expectedCandidateSha || row.remoteCandidateSha !== row.expectedCandidateSha) {
    throw new AgentRunConflictError("The candidate changed before rollback execution");
  }
  const now = Date.now();
  await database.prepare(
    `UPDATE agent_run_rollbacks SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
     WHERE id = ? AND status IN ('requested', 'running')`,
  ).bind(now, now, rollbackId).run();
  const commands = await database.prepare(
    `SELECT command FROM repository_check_commands
     WHERE connection_id = (SELECT connection_id FROM repository_candidates WHERE id = ?)
     ORDER BY position`,
  ).bind(row.candidateId).all<{ command: string }>();
  if (commands.results.length === 0) throw new AgentRunConflictError("Configure at least one required check before rollback");
  return { ...row, repositoryPrivate: Boolean(row.repositoryPrivate), status: "running", commands: commands.results.map((item) => item.command) };
}

export async function finishAgentRunRollback(
  rollbackId: string,
  rollbackCommitSha: string,
  database = getDb(),
): Promise<{ sessionId: string; revision: number } | null> {
  const rollback = await database.prepare(
    `SELECT id, run_id AS runId, session_id AS sessionId, candidate_id AS candidateId,
            expected_candidate_sha AS expectedCandidateSha, rollback_commit_sha AS rollbackCommitSha, status
     FROM agent_run_rollbacks WHERE id = ?`,
  ).bind(rollbackId).first<{
    id: string; runId: string; sessionId: string; candidateId: string; expectedCandidateSha: string;
    rollbackCommitSha: string | null; status: AgentRunRollbackStatus;
  }>();
  if (!rollback) return null;
  if (rollback.status === "completed" && rollback.rollbackCommitSha === rollbackCommitSha) {
    const current = await database.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?")
      .bind(rollback.sessionId).first<{ revision: number }>();
    return { sessionId: rollback.sessionId, revision: Number(current?.revision ?? 0) };
  }
  if (rollback.status !== "running") throw new AgentRunConflictError("This rollback is not running");
  const now = Date.now();
  const results = await database.batch([
    database.prepare(
      `UPDATE repository_candidates SET candidate_sha = ?, remote_candidate_sha = ?, integration_run_id = NULL,
              github_checks_passing = NULL, pull_request_mergeable = NULL, pull_request_mergeable_state = NULL,
              review_synced_at = NULL, last_synced_at = ?, updated_at = ?
       WHERE id = ? AND integration_run_id = ? AND candidate_sha = ? AND remote_candidate_sha = ?`,
    ).bind(rollbackCommitSha, rollbackCommitSha, now, now, rollback.candidateId, rollback.runId,
      rollback.expectedCandidateSha, rollback.expectedCandidateSha),
    database.prepare(
      `UPDATE agent_run_rollbacks SET status = 'completed', rollback_commit_sha = ?, failure_reason = NULL,
              completed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'running'
         AND EXISTS (
           SELECT 1 FROM repository_candidates c
           WHERE c.id = ? AND c.candidate_sha = ? AND c.remote_candidate_sha = ?
             AND c.integration_run_id IS NULL
         )`,
    ).bind(rollbackCommitSha, now, now, rollbackId, rollback.candidateId, rollbackCommitSha, rollbackCommitSha),
    database.prepare(
      `DELETE FROM repository_candidate_files WHERE candidate_id = ?
       AND EXISTS (
         SELECT 1 FROM agent_run_rollbacks rb
         WHERE rb.id = ? AND rb.status = 'completed' AND rb.rollback_commit_sha = ?
       )`,
    ).bind(rollback.candidateId, rollbackId, rollbackCommitSha),
    database.prepare(
      `DELETE FROM repository_candidate_checks WHERE candidate_id = ?
       AND EXISTS (
         SELECT 1 FROM agent_run_rollbacks rb
         WHERE rb.id = ? AND rb.status = 'completed' AND rb.rollback_commit_sha = ?
       )`,
    ).bind(rollback.candidateId, rollbackId, rollbackCommitSha),
    database.prepare(
      `UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?
       AND EXISTS (
         SELECT 1 FROM agent_run_rollbacks rb
         WHERE rb.id = ? AND rb.status = 'completed' AND rb.rollback_commit_sha = ?
           AND rb.completed_at = ?
       )`,
    ).bind(now, rollback.sessionId, rollbackId, rollbackCommitSha, now),
  ]);
  // The candidate UPDATE may be a no-op when D1 committed it before a retry
  // observed the response. Completion is safe only when the exact published
  // SHA is now authoritative and the rollback row transitioned with it.
  if (!results[1]?.meta?.changes) {
    throw new AgentRunConflictError("The candidate changed before rollback could be recorded");
  }
  await appendRunEvent(rollback.runId, "rolled_back", `Candidate advanced to rollback commit ${rollbackCommitSha}.`, database);
  const revision = await database.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?")
    .bind(rollback.sessionId).first<{ revision: number }>();
  return { sessionId: rollback.sessionId, revision: Number(revision?.revision ?? 0) };
}

export async function failAgentRunRollback(
  rollbackId: string,
  reason: string,
  database = getDb(),
): Promise<{ sessionId: string; revision: number } | null> {
  const rollback = await database.prepare(
    "SELECT run_id AS runId, session_id AS sessionId, candidate_id AS candidateId, status FROM agent_run_rollbacks WHERE id = ?",
  ).bind(rollbackId).first<{ runId: string; sessionId: string; candidateId: string; status: AgentRunRollbackStatus }>();
  if (!rollback || !["requested", "running"].includes(rollback.status)) return null;
  const now = Date.now();
  await database.batch([
    database.prepare("UPDATE repository_candidates SET integration_run_id = NULL, updated_at = ? WHERE id = ? AND integration_run_id = ?")
      .bind(now, rollback.candidateId, rollback.runId),
    database.prepare(
      `UPDATE agent_run_rollbacks SET status = 'failed', failure_reason = ?, completed_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('requested', 'running')`,
    ).bind(reason.slice(0, 2_000), now, now, rollbackId),
    database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?")
      .bind(now, rollback.sessionId),
  ]);
  await appendRunEvent(rollback.runId, "rollback_failed", reason, database);
  const revision = await database.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?")
    .bind(rollback.sessionId).first<{ revision: number }>();
  return { sessionId: rollback.sessionId, revision: Number(revision?.revision ?? 0) };
}
