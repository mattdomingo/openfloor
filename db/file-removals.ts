import type { CandidateFileRemovalStatus } from "@/lib/floor-types";
import { getDb } from "./index";
import { AgentRunConflictError } from "./runs";
import { getActiveMembershipRole } from "./sessions";

export type CandidateFileRemovalContext = {
  id: string;
  sessionId: string;
  candidateId: string;
  path: string;
  previousPath: string | null;
  expectedCandidateSha: string;
  baseSha: string;
  status: CandidateFileRemovalStatus;
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
};

export async function createCandidateFileRemoval(
  sessionId: string,
  userId: string,
  input: { path: string; expectedCandidateSha: string },
  database = getDb(),
): Promise<{ removalId: string; revision: number } | null> {
  if ((await getActiveMembershipRole(sessionId, userId, database)) !== "owner") return null;
  const candidate = await database.prepare(
    `SELECT c.id, c.candidate_sha AS candidateSha, c.remote_candidate_sha AS remoteCandidateSha,
            c.remote_base_sha AS remoteBaseSha, c.integration_run_id AS integrationRunId,
            c.merged_at AS mergedAt, c.abandoned_at AS abandonedAt, c.status,
            rc.status AS connectionStatus, f.path AS filePath, f.previous_path AS previousPath
     FROM repository_candidates c
     JOIN repository_connections rc ON rc.id = c.connection_id
     LEFT JOIN repository_candidate_files f ON f.candidate_id = c.id AND f.path = ?
     WHERE c.session_id = ? AND c.status = 'active' AND c.merged_at IS NULL AND c.abandoned_at IS NULL
     ORDER BY c.created_at DESC LIMIT 1`,
  ).bind(input.path, sessionId).first<{
    id: string; candidateSha: string | null; remoteCandidateSha: string | null; remoteBaseSha: string | null;
    integrationRunId: string | null; mergedAt: number | null; abandonedAt: number | null; status: string;
    connectionStatus: string; filePath: string | null; previousPath: string | null;
  }>();
  if (!candidate) throw new AgentRunConflictError("The candidate is no longer open for file removal");
  if (!candidate.filePath) throw new AgentRunConflictError("This file is no longer changed");
  if (candidate.connectionStatus !== "ready" || !candidate.candidateSha || candidate.remoteCandidateSha !== candidate.candidateSha ||
      candidate.candidateSha !== input.expectedCandidateSha || !candidate.remoteBaseSha || candidate.integrationRunId) {
    throw new AgentRunConflictError("Synchronize the unchanged candidate before removing this file's changes");
  }

  const removalId = crypto.randomUUID();
  const now = Date.now();
  const claimed = await database.prepare(
    `UPDATE repository_candidates SET integration_run_id = ?, updated_at = ?
     WHERE id = ? AND integration_run_id IS NULL AND candidate_sha = ? AND remote_candidate_sha = ?
       AND remote_base_sha = ? AND status = 'active' AND merged_at IS NULL AND abandoned_at IS NULL
       AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND ended_at IS NULL)`,
  ).bind(removalId, now, candidate.id, input.expectedCandidateSha, input.expectedCandidateSha, candidate.remoteBaseSha, sessionId).run();
  if (!claimed.meta?.changes) throw new AgentRunConflictError("The candidate changed before file removal could start");

  try {
    await database.batch([
      database.prepare(
        `INSERT INTO candidate_file_removals
         (id, session_id, candidate_id, path, previous_path, expected_candidate_sha, base_sha,
          status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?)`,
      ).bind(removalId, sessionId, candidate.id, input.path, candidate.previousPath,
        input.expectedCandidateSha, candidate.remoteBaseSha, userId, now, now),
      database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ? AND ended_at IS NULL")
        .bind(now, sessionId),
    ]);
  } catch (error) {
    await database.prepare("UPDATE repository_candidates SET integration_run_id = NULL, updated_at = ? WHERE id = ? AND integration_run_id = ?")
      .bind(Date.now(), candidate.id, removalId).run();
    throw error;
  }
  const revision = await database.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?")
    .bind(sessionId).first<{ revision: number }>();
  return { removalId, revision: Number(revision?.revision ?? 0) };
}

export async function beginCandidateFileRemoval(
  removalId: string,
  database = getDb(),
): Promise<CandidateFileRemovalContext> {
  const row = await database.prepare(
    `SELECT removal.id, removal.session_id AS sessionId, removal.candidate_id AS candidateId,
            removal.path, removal.previous_path AS previousPath,
            removal.expected_candidate_sha AS expectedCandidateSha, removal.base_sha AS baseSha,
            removal.status, removal.created_at AS createdAt,
            c.branch_name AS candidateBranch, c.base_branch AS baseBranch,
            c.integration_run_id AS integrationRunId, c.candidate_sha AS candidateSha,
            c.remote_candidate_sha AS remoteCandidateSha, c.remote_base_sha AS remoteBaseSha,
            rc.installation_id AS installationId, rc.repository_id AS repositoryId,
            rc.repository_owner AS repositoryOwner, rc.repository_name AS repositoryName,
            rc.repository_full_name AS repositoryFullName, rc.repository_private AS repositoryPrivate,
            rc.default_branch AS defaultBranch, rc.status AS connectionStatus
     FROM candidate_file_removals removal
     JOIN repository_candidates c ON c.id = removal.candidate_id
       AND c.status = 'active' AND c.merged_at IS NULL AND c.abandoned_at IS NULL
     JOIN repository_connections rc ON rc.id = c.connection_id
     WHERE removal.id = ?`,
  ).bind(removalId).first<Omit<CandidateFileRemovalContext, "repositoryPrivate"> & {
    integrationRunId: string | null; candidateSha: string | null; remoteCandidateSha: string | null;
    remoteBaseSha: string | null; connectionStatus: string; repositoryPrivate: number;
  }>();
  if (!row || !["requested", "running"].includes(row.status) || row.integrationRunId !== removalId ||
      row.connectionStatus !== "ready" || row.candidateSha !== row.expectedCandidateSha ||
      row.remoteCandidateSha !== row.expectedCandidateSha || row.remoteBaseSha !== row.baseSha) {
    throw new AgentRunConflictError("This file removal is no longer available");
  }
  const now = Date.now();
  await database.prepare(
    `UPDATE candidate_file_removals SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
     WHERE id = ? AND status IN ('requested', 'running')`,
  ).bind(now, now, removalId).run();
  return { ...row, status: "running", repositoryPrivate: Boolean(row.repositoryPrivate) };
}

export async function finishCandidateFileRemoval(
  removalId: string,
  removalCommitSha: string,
  database = getDb(),
): Promise<{ sessionId: string; revision: number } | null> {
  const removal = await database.prepare(
    `SELECT id, session_id AS sessionId, candidate_id AS candidateId, path,
            expected_candidate_sha AS expectedCandidateSha, removal_commit_sha AS removalCommitSha, status
     FROM candidate_file_removals WHERE id = ?`,
  ).bind(removalId).first<{
    id: string; sessionId: string; candidateId: string; path: string; expectedCandidateSha: string;
    removalCommitSha: string | null; status: CandidateFileRemovalStatus;
  }>();
  if (!removal) return null;
  if (removal.status === "completed" && removal.removalCommitSha === removalCommitSha) {
    const current = await database.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?")
      .bind(removal.sessionId).first<{ revision: number }>();
    return { sessionId: removal.sessionId, revision: Number(current?.revision ?? 0) };
  }
  if (removal.status !== "running") throw new AgentRunConflictError("This file removal is not running");
  const now = Date.now();
  const results = await database.batch([
    database.prepare(
      `UPDATE repository_candidates SET candidate_sha = ?, remote_candidate_sha = ?, integration_run_id = NULL,
              github_checks_passing = NULL, pull_request_mergeable = NULL, pull_request_mergeable_state = NULL,
              review_synced_at = NULL, last_synced_at = ?, updated_at = ?
       WHERE id = ? AND integration_run_id = ? AND candidate_sha = ? AND remote_candidate_sha = ?`,
    ).bind(removalCommitSha, removalCommitSha, now, now, removal.candidateId, removalId,
      removal.expectedCandidateSha, removal.expectedCandidateSha),
    database.prepare(
      `UPDATE candidate_file_removals SET status = 'completed', removal_commit_sha = ?, failure_reason = NULL,
              completed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'running'
         AND EXISTS (SELECT 1 FROM repository_candidates c WHERE c.id = ? AND c.candidate_sha = ?
           AND c.remote_candidate_sha = ? AND c.integration_run_id IS NULL)`,
    ).bind(removalCommitSha, now, now, removalId, removal.candidateId, removalCommitSha, removalCommitSha),
    database.prepare(
      `DELETE FROM repository_candidate_files WHERE candidate_id = ? AND path = ?
       AND EXISTS (SELECT 1 FROM candidate_file_removals done WHERE done.id = ? AND done.status = 'completed')`,
    ).bind(removal.candidateId, removal.path, removalId),
    database.prepare(
      `DELETE FROM repository_candidate_checks WHERE candidate_id = ?
       AND EXISTS (SELECT 1 FROM candidate_file_removals done WHERE done.id = ? AND done.status = 'completed')`,
    ).bind(removal.candidateId, removalId),
    database.prepare(
      `UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?
       AND EXISTS (SELECT 1 FROM candidate_file_removals done WHERE done.id = ? AND done.status = 'completed' AND done.completed_at = ?)`,
    ).bind(now, removal.sessionId, removalId, now),
  ]);
  if (!results[0]?.meta?.changes || !results[1]?.meta?.changes) {
    throw new AgentRunConflictError("The candidate changed before file removal could be recorded");
  }
  const revision = await database.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?")
    .bind(removal.sessionId).first<{ revision: number }>();
  return { sessionId: removal.sessionId, revision: Number(revision?.revision ?? 0) };
}

export async function failCandidateFileRemoval(
  removalId: string,
  reason: string,
  database = getDb(),
): Promise<{ sessionId: string; revision: number } | null> {
  const removal = await database.prepare(
    "SELECT session_id AS sessionId, candidate_id AS candidateId, status FROM candidate_file_removals WHERE id = ?",
  ).bind(removalId).first<{ sessionId: string; candidateId: string; status: CandidateFileRemovalStatus }>();
  if (!removal || !["requested", "running"].includes(removal.status)) return null;
  const now = Date.now();
  await database.batch([
    database.prepare("UPDATE repository_candidates SET integration_run_id = NULL, updated_at = ? WHERE id = ? AND integration_run_id = ?")
      .bind(now, removal.candidateId, removalId),
    database.prepare(
      `UPDATE candidate_file_removals SET status = 'failed', failure_reason = ?, completed_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('requested', 'running')`,
    ).bind(reason.slice(0, 2_000), now, now, removalId),
    database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?")
      .bind(now, removal.sessionId),
  ]);
  const revision = await database.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?")
    .bind(removal.sessionId).first<{ revision: number }>();
  return { sessionId: removal.sessionId, revision: Number(revision?.revision ?? 0) };
}
