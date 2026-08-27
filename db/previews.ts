import type { RepositoryPreviewSnapshot } from "@/lib/floor-types";
import { previewSandboxId } from "@/lib/repository-preview-id";
import { getDb, type D1DatabaseLike } from "./index";
import { getActiveMembershipRole } from "./sessions";

export const PREVIEW_LEASE_MS = 60 * 60 * 1_000;
export const MAX_ACTIVE_PREVIEWS = 3;
export const MAX_PREVIEW_FAILURE_CHARS = 1_000;

export class RepositoryPreviewNotReadyError extends Error {}
export class RepositoryPreviewCapacityError extends Error {}

export type RepositoryPreviewRecord = {
  id: string;
  sessionId: string;
  candidateId: string;
  generation: number;
  status: "stopped" | "provisioning" | "ready" | "failed";
  targetCandidateSha: string;
  activeCandidateSha: string | null;
  workflowInstanceId: string | null;
  pendingSandboxId: string | null;
  activeSandboxId: string | null;
  activeUrl: string | null;
  activeHost: string | null;
  detectedPackageManager: "npm" | "pnpm" | "yarn" | "bun" | null;
  detectedScript: "dev" | "start" | null;
  failureReason: string | null;
  startedBy: string;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
};

const PREVIEW_COLUMNS = `id, session_id AS sessionId, candidate_id AS candidateId, generation, status,
  target_candidate_sha AS targetCandidateSha, active_candidate_sha AS activeCandidateSha,
  workflow_instance_id AS workflowInstanceId, pending_sandbox_id AS pendingSandboxId,
  active_sandbox_id AS activeSandboxId, active_url AS activeUrl, active_host AS activeHost,
  detected_package_manager AS detectedPackageManager, detected_script AS detectedScript,
  failure_reason AS failureReason, started_by AS startedBy, expires_at AS expiresAt,
  created_at AS createdAt, updated_at AS updatedAt`;

export async function getRepositoryPreview(
  sessionId: string,
  database = getDb(),
): Promise<RepositoryPreviewSnapshot | null> {
  const row = await getRepositoryPreviewRecord(sessionId, database);
  if (!row || row.status === "stopped") return null;
  const expired = row.expiresAt != null && row.expiresAt <= Date.now();
  return {
    status: expired ? "expired" : row.status,
    targetCandidateSha: row.targetCandidateSha,
    activeCandidateSha: row.activeCandidateSha,
    url: expired ? null : row.activeUrl,
    packageManager: row.detectedPackageManager,
    script: row.detectedScript,
    failureReason: row.failureReason,
    expiresAt: row.expiresAt,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

export async function getRepositoryPreviewRecord(
  sessionId: string,
  database = getDb(),
): Promise<RepositoryPreviewRecord | null> {
  return database.prepare(`SELECT ${PREVIEW_COLUMNS} FROM repository_previews WHERE session_id = ?`)
    .bind(sessionId).first<RepositoryPreviewRecord>();
}

type CandidateContext = {
  candidateId: string;
  candidateSha: string;
  remoteCandidateSha: string | null;
  connectionStatus: string;
};

async function activeCandidateContext(sessionId: string, database: D1DatabaseLike): Promise<CandidateContext | null> {
  return database.prepare(
    `SELECT c.id AS candidateId, c.candidate_sha AS candidateSha,
            c.remote_candidate_sha AS remoteCandidateSha, rc.status AS connectionStatus
     FROM repository_candidates c
     JOIN repository_connections rc ON rc.id = c.connection_id
     WHERE c.session_id = ? AND c.status = 'active' AND c.merged_at IS NULL
       AND c.abandoned_at IS NULL`,
  ).bind(sessionId).first<CandidateContext>();
}

export async function reserveRepositoryPreview(
  sessionId: string,
  userId: string,
  database = getDb(),
): Promise<RepositoryPreviewRecord> {
  if ((await getActiveMembershipRole(sessionId, userId, database)) !== "owner") {
    throw new RepositoryPreviewNotReadyError("Session not found");
  }
  const candidate = await activeCandidateContext(sessionId, database);
  if (!candidate || candidate.connectionStatus !== "ready" || !candidate.candidateSha
    || candidate.remoteCandidateSha !== candidate.candidateSha) {
    throw new RepositoryPreviewNotReadyError("Synchronize a ready, unmodified candidate before starting preview");
  }
  const previous = await getRepositoryPreviewRecord(sessionId, database);
  if (previous?.status === "provisioning" && previous.targetCandidateSha === candidate.candidateSha) return previous;

  const now = Date.now();
  const generation = (previous?.generation ?? 0) + 1;
  const id = previous?.id ?? crypto.randomUUID();
  const workflowId = `${id}-${generation}`;
  const sandboxId = previewSandboxId();
  const expiresAt = now + PREVIEW_LEASE_MS;
  const result = await database.prepare(
    `INSERT INTO repository_previews
       (id, session_id, candidate_id, generation, status, target_candidate_sha,
        workflow_instance_id, pending_sandbox_id, started_by, expires_at, created_at, updated_at)
     SELECT ?, ?, ?, ?, 'provisioning', ?, ?, ?, ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM repository_previews
            WHERE session_id != ? AND (status = 'provisioning' OR (status IN ('ready', 'failed') AND active_sandbox_id IS NOT NULL))
              AND expires_at > ?) < ?
     ON CONFLICT(session_id) DO UPDATE SET
       candidate_id = excluded.candidate_id, generation = excluded.generation,
       status = 'provisioning', target_candidate_sha = excluded.target_candidate_sha,
       workflow_instance_id = excluded.workflow_instance_id,
       pending_sandbox_id = excluded.pending_sandbox_id, failure_reason = NULL,
       started_by = excluded.started_by, expires_at = excluded.expires_at,
       updated_at = excluded.updated_at
     WHERE (SELECT COUNT(*) FROM repository_previews
            WHERE session_id != excluded.session_id AND (status = 'provisioning' OR (status IN ('ready', 'failed') AND active_sandbox_id IS NOT NULL))
              AND expires_at > ?) < ?`,
  ).bind(
    id, sessionId, candidate.candidateId, generation, candidate.candidateSha,
    workflowId, sandboxId, userId, expiresAt, now, now,
    sessionId, now, MAX_ACTIVE_PREVIEWS, now, MAX_ACTIVE_PREVIEWS,
  ).run();
  if (!result.meta?.changes) throw new RepositoryPreviewCapacityError("Preview capacity is currently full");
  await bumpFloorRevision(sessionId, now, database);
  return (await getRepositoryPreviewRecord(sessionId, database))!;
}

// Integration/rollback refresh: preserve remaining lease and old active URL.
// No row or expired/stopped row means preview was not requested, so do nothing.
export async function reserveAutomaticRepositoryPreview(
  sessionId: string,
  database = getDb(),
): Promise<RepositoryPreviewRecord | null> {
  const candidate = await activeCandidateContext(sessionId, database);
  const previous = await getRepositoryPreviewRecord(sessionId, database);
  const now = Date.now();
  if (!candidate || !previous || previous.status === "stopped" || !previous.expiresAt || previous.expiresAt <= now) return null;
  if (previous.targetCandidateSha === candidate.candidateSha && previous.status === "provisioning") return previous;
  if (previous.activeCandidateSha === candidate.candidateSha && previous.status === "ready") return null;
  const generation = previous.generation + 1;
  const result = await database.prepare(
    `UPDATE repository_previews SET candidate_id = ?, generation = ?, status = 'provisioning',
            target_candidate_sha = ?, workflow_instance_id = ?, pending_sandbox_id = ?,
            failure_reason = NULL, updated_at = ?
     WHERE id = ? AND generation = ? AND expires_at > ? AND status != 'stopped'`,
  ).bind(candidate.candidateId, generation, candidate.candidateSha, `${previous.id}-${generation}`,
    previewSandboxId(), now, previous.id, previous.generation, now).run();
  if (!result.meta?.changes) return null;
  await bumpFloorRevision(sessionId, now, database);
  return getRepositoryPreviewRecord(sessionId, database);
}

export async function getRepositoryPreviewExecutionContext(
  previewId: string,
  generation: number,
  database = getDb(),
) {
  return database.prepare(
    `SELECT p.id, p.session_id AS sessionId, p.candidate_id AS candidateId, p.generation,
            p.target_candidate_sha AS candidateSha, p.pending_sandbox_id AS sandboxId,
            p.expires_at AS expiresAt, p.status,
            rc.installation_id AS installationId, rc.repository_id AS repositoryId,
            rc.repository_owner AS repositoryOwner, rc.repository_name AS repositoryName
     FROM repository_previews p
     JOIN repository_candidates c ON c.id = p.candidate_id
     JOIN repository_connections rc ON rc.id = c.connection_id
     JOIN sessions s ON s.id = p.session_id
     WHERE p.id = ? AND p.generation = ? AND p.status = 'provisioning'
       AND p.pending_sandbox_id IS NOT NULL AND p.expires_at > ? AND s.ended_at IS NULL
       AND c.status = 'active' AND c.merged_at IS NULL AND c.abandoned_at IS NULL
       AND c.candidate_sha = p.target_candidate_sha AND c.remote_candidate_sha = p.target_candidate_sha
       AND rc.status = 'ready'`,
  ).bind(previewId, generation, Date.now()).first<{
    id: string; sessionId: string; candidateId: string; generation: number; candidateSha: string;
    sandboxId: string; expiresAt: number; status: "provisioning"; installationId: string;
    repositoryId: string; repositoryOwner: string; repositoryName: string;
  }>();
}

export async function activateRepositoryPreview(
  previewId: string,
  generation: number,
  input: { url: string; host: string; packageManager: RepositoryPreviewRecord["detectedPackageManager"]; script: RepositoryPreviewRecord["detectedScript"] },
  database = getDb(),
): Promise<{ sessionId: string; revision: number; oldSandboxId: string | null } | null> {
  const row = await database.prepare(
    `SELECT session_id AS sessionId, active_sandbox_id AS oldSandboxId, pending_sandbox_id AS pendingSandboxId
     FROM repository_previews WHERE id = ? AND generation = ? AND status = 'provisioning' AND expires_at > ?`,
  ).bind(previewId, generation, Date.now()).first<{ sessionId: string; oldSandboxId: string | null; pendingSandboxId: string | null }>();
  if (!row?.pendingSandboxId) return null;
  const now = Date.now();
  const update = await database.prepare(
    `UPDATE repository_previews SET status = 'ready', active_candidate_sha = target_candidate_sha,
            active_sandbox_id = pending_sandbox_id, pending_sandbox_id = NULL,
            active_url = ?, active_host = ?, detected_package_manager = ?, detected_script = ?,
            failure_reason = NULL, updated_at = ?
     WHERE id = ? AND generation = ? AND status = 'provisioning' AND expires_at > ?
       AND EXISTS (
         SELECT 1 FROM repository_candidates c
         JOIN repository_connections rc ON rc.id = c.connection_id
         JOIN sessions s ON s.id = repository_previews.session_id
         WHERE c.id = repository_previews.candidate_id
           AND c.session_id = repository_previews.session_id
           AND c.status = 'active' AND c.merged_at IS NULL AND c.abandoned_at IS NULL
           AND c.candidate_sha = repository_previews.target_candidate_sha
           AND c.remote_candidate_sha = repository_previews.target_candidate_sha
           AND rc.status = 'ready' AND s.ended_at IS NULL
       )`,
  ).bind(input.url, input.host, input.packageManager, input.script, now, previewId, generation, now).run();
  if (!update.meta?.changes) return null;
  const revision = await bumpFloorRevision(row.sessionId, now, database);
  return { sessionId: row.sessionId, revision, oldSandboxId: row.oldSandboxId };
}

export async function failRepositoryPreview(
  previewId: string,
  generation: number,
  reason: string,
  database = getDb(),
): Promise<{ sessionId: string; revision: number } | null> {
  const row = await database.prepare("SELECT session_id AS sessionId FROM repository_previews WHERE id = ? AND generation = ? AND status = 'provisioning'")
    .bind(previewId, generation).first<{ sessionId: string }>();
  if (!row) return null;
  const now = Date.now();
  const update = await database.prepare(
    `UPDATE repository_previews SET status = 'failed', pending_sandbox_id = NULL,
            failure_reason = ?, updated_at = ? WHERE id = ? AND generation = ? AND status = 'provisioning'`,
  ).bind(reason.slice(0, MAX_PREVIEW_FAILURE_CHARS), now, previewId, generation).run();
  if (!update.meta?.changes) return null;
  return { sessionId: row.sessionId, revision: await bumpFloorRevision(row.sessionId, now, database) };
}

export async function stopRepositoryPreview(
  sessionId: string,
  database = getDb(),
  expectedGeneration?: number,
): Promise<{ revision: number; sandboxIds: string[] } | null> {
  const row = await getRepositoryPreviewRecord(sessionId, database);
  if (!row || row.status === "stopped" || (expectedGeneration != null && row.generation !== expectedGeneration)) return null;
  const now = Date.now();
  const update = await database.prepare(
    `UPDATE repository_previews SET generation = generation + 1, status = 'stopped',
            workflow_instance_id = NULL, pending_sandbox_id = NULL, active_sandbox_id = NULL,
            active_url = NULL, active_host = NULL, failure_reason = NULL, expires_at = NULL,
            updated_at = ? WHERE session_id = ? AND generation = ? AND status != 'stopped'`,
  ).bind(now, sessionId, row.generation).run();
  if (!update.meta?.changes) return null;
  const revision = await bumpFloorRevision(sessionId, now, database);
  return { revision, sandboxIds: [...new Set([row.pendingSandboxId, row.activeSandboxId].filter((id): id is string => Boolean(id)))] };
}

export async function getPreviewProxyContext(host: string, userId: string, database = getDb()) {
  return database.prepare(
    `SELECT p.session_id AS sessionId, p.active_sandbox_id AS sandboxId
     FROM repository_previews p
     JOIN sessions s ON s.id = p.session_id AND s.ended_at IS NULL
     JOIN session_members sm ON sm.session_id = p.session_id AND sm.user_id = ? AND sm.removed_at IS NULL
     WHERE p.active_host = ? AND p.active_sandbox_id IS NOT NULL AND p.active_url IS NOT NULL
       AND p.status IN ('ready', 'failed', 'provisioning') AND p.expires_at > ?`,
  ).bind(userId, host.toLowerCase(), Date.now()).first<{ sessionId: string; sandboxId: string }>();
}

export async function getPreviewMemberUserId(providerUserId: string, email: string, database = getDb()): Promise<string | null> {
  const row = await database.prepare("SELECT id FROM users WHERE (chatgpt_user_id = ? OR email = ?) AND deleted_at IS NULL LIMIT 1")
    .bind(providerUserId, email).first<{ id: string }>();
  return row?.id ?? null;
}

export async function takeExpiredRepositoryPreviews(database = getDb()): Promise<Array<{ sessionId: string; sandboxIds: string[] }>> {
  const now = Date.now();
  const rows = await database.prepare(
    `SELECT session_id AS sessionId, generation, pending_sandbox_id AS pendingSandboxId, active_sandbox_id AS activeSandboxId
     FROM repository_previews WHERE status != 'stopped' AND expires_at <= ?`,
  ).bind(now).all<{ sessionId: string; generation: number; pendingSandboxId: string | null; activeSandboxId: string | null }>();
  const output: Array<{ sessionId: string; sandboxIds: string[] }> = [];
  for (const row of rows.results) {
    const stopped = await stopRepositoryPreview(row.sessionId, database, row.generation);
    if (stopped) output.push({ sessionId: row.sessionId, sandboxIds: stopped.sandboxIds });
  }
  return output;
}

async function bumpFloorRevision(sessionId: string, now: number, database: D1DatabaseLike): Promise<number> {
  await database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?")
    .bind(now, sessionId).run();
  const row = await database.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?")
    .bind(sessionId).first<{ revision: number }>();
  return Number(row?.revision ?? 0);
}
