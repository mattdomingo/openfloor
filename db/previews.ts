import type { RepositoryPreviewSnapshot } from "@/lib/floor-types";
import { previewSandboxId } from "@/lib/repository-preview-id";
import { getDb, type D1DatabaseLike } from "./index";
import { getActiveMembershipRole } from "./sessions";

export const PREVIEW_LEASE_MS = 60 * 60 * 1_000;
export const MAX_ACTIVE_PREVIEWS = 3;
export const MAX_PREVIEW_FAILURE_CHARS = 1_000;
export const SANDBOX_CLEANUP_RETRY_MS = 10 * 60 * 1_000;

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

export type RepositoryPreviewReservation = RepositoryPreviewRecord & { reservationCreated: boolean };

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
  if (!row || row.status === "stopped" || row.expiresAt == null) return null;
  const expired = row.expiresAt <= Date.now();
  return {
    status: expired ? "expired" : row.status,
    targetCandidateSha: row.targetCandidateSha,
    activeCandidateSha: row.activeCandidateSha,
    url: expired ? null : row.activeUrl,
    packageManager: row.detectedPackageManager,
    script: row.detectedScript,
    failureReason: row.failureReason,
    expiresAt: Number(row.expiresAt),
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
     JOIN sessions s ON s.id = c.session_id AND s.ended_at IS NULL
     WHERE c.session_id = ? AND c.status = 'active' AND c.merged_at IS NULL
       AND c.abandoned_at IS NULL`,
  ).bind(sessionId).first<CandidateContext>();
}

export async function reserveRepositoryPreview(
  sessionId: string,
  userId: string,
  database = getDb(),
): Promise<RepositoryPreviewReservation> {
  if ((await getActiveMembershipRole(sessionId, userId, database)) !== "owner") {
    throw new RepositoryPreviewNotReadyError("Session not found");
  }
  const candidate = await activeCandidateContext(sessionId, database);
  if (!candidate || candidate.connectionStatus !== "ready" || !candidate.candidateSha
    || candidate.remoteCandidateSha !== candidate.candidateSha) {
    throw new RepositoryPreviewNotReadyError("Synchronize a ready, unmodified candidate before starting preview");
  }
  const previous = await getRepositoryPreviewRecord(sessionId, database);
  if (previous?.status === "provisioning" && previous.targetCandidateSha === candidate.candidateSha) {
    return { ...previous, reservationCreated: false };
  }

  const now = Date.now();
  const generation = (previous?.generation ?? 0) + 1;
  const id = previous?.id ?? crypto.randomUUID();
  const result = await database.prepare(
    `INSERT INTO repository_previews
       (id, session_id, candidate_id, generation, status, target_candidate_sha,
        workflow_instance_id, pending_sandbox_id, started_by, expires_at, created_at, updated_at)
     SELECT ?, ?, ?, ?, 'provisioning', ?, ?, ?, ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM repository_previews
            WHERE session_id != ? AND expires_at > ?
              AND (status IN ('provisioning', 'ready') OR active_sandbox_id IS NOT NULL)) < ?
     ON CONFLICT(session_id) DO UPDATE SET
       candidate_id = excluded.candidate_id, generation = excluded.generation,
       status = 'provisioning', target_candidate_sha = excluded.target_candidate_sha,
       workflow_instance_id = excluded.workflow_instance_id,
       pending_sandbox_id = excluded.pending_sandbox_id, failure_reason = NULL,
       active_candidate_sha = CASE WHEN repository_previews.expires_at <= excluded.updated_at THEN NULL ELSE repository_previews.active_candidate_sha END,
       active_sandbox_id = CASE WHEN repository_previews.expires_at <= excluded.updated_at THEN NULL ELSE repository_previews.active_sandbox_id END,
       active_url = CASE WHEN repository_previews.expires_at <= excluded.updated_at THEN NULL ELSE repository_previews.active_url END,
       active_host = CASE WHEN repository_previews.expires_at <= excluded.updated_at THEN NULL ELSE repository_previews.active_host END,
       detected_package_manager = CASE WHEN repository_previews.expires_at <= excluded.updated_at THEN NULL ELSE repository_previews.detected_package_manager END,
       detected_script = CASE WHEN repository_previews.expires_at <= excluded.updated_at THEN NULL ELSE repository_previews.detected_script END,
       started_by = excluded.started_by, expires_at = excluded.expires_at,
       updated_at = excluded.updated_at
     WHERE repository_previews.generation = ?
       AND (SELECT COUNT(*) FROM repository_previews
            WHERE session_id != excluded.session_id AND expires_at > ?
              AND (status IN ('provisioning', 'ready') OR active_sandbox_id IS NOT NULL)) < ?`,
  ).bind(
    id, sessionId, candidate.candidateId, generation, candidate.candidateSha,
    `${id}-${generation}`, previewSandboxId(), userId, now + PREVIEW_LEASE_MS, now, now,
    sessionId, now, MAX_ACTIVE_PREVIEWS, previous?.generation ?? 0, now, MAX_ACTIVE_PREVIEWS,
  ).run();
  if (!result.meta?.changes) {
    const current = await getRepositoryPreviewRecord(sessionId, database);
    if (current && current.generation !== previous?.generation) {
      return { ...current, reservationCreated: false };
    }
    throw new RepositoryPreviewCapacityError("Preview capacity is currently full");
  }
  await enqueueSandboxCleanup([
    previous?.pendingSandboxId ?? "",
    previous?.expiresAt != null && previous.expiresAt <= now ? previous.activeSandboxId ?? "" : "",
  ], database, now);
  await bumpFloorRevision(sessionId, now, database);
  return { ...(await getRepositoryPreviewRecord(sessionId, database))!, reservationCreated: true };
}

// Integration/rollback refresh preserves remaining lease and prior active URL.
export async function reserveAutomaticRepositoryPreview(
  sessionId: string,
  database = getDb(),
): Promise<RepositoryPreviewRecord | null> {
  const [candidate, previous] = await Promise.all([
    activeCandidateContext(sessionId, database),
    getRepositoryPreviewRecord(sessionId, database),
  ]);
  const now = Date.now();
  if (!candidate || candidate.connectionStatus !== "ready" || !previous || previous.status === "stopped"
    || !previous.expiresAt || previous.expiresAt <= now) return null;
  if (previous.targetCandidateSha === candidate.candidateSha && previous.status === "provisioning") return null;
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
  if (previous.pendingSandboxId) await enqueueSandboxCleanup([previous.pendingSandboxId], database, now);
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
  ).bind(input.url, input.host.toLowerCase(), input.packageManager, input.script, now, previewId, generation, now).run();
  if (!update.meta?.changes) return null;
  if (row.oldSandboxId && row.oldSandboxId !== row.pendingSandboxId) {
    await enqueueSandboxCleanup([row.oldSandboxId], database, now);
  }
  const revision = await bumpFloorRevision(row.sessionId, now, database);
  return { sessionId: row.sessionId, revision, oldSandboxId: row.oldSandboxId };
}

export async function failRepositoryPreview(
  previewId: string,
  generation: number,
  reason: string,
  database = getDb(),
): Promise<{ sessionId: string; revision: number; sandboxId: string | null } | null> {
  const row = await database.prepare(
    "SELECT session_id AS sessionId, pending_sandbox_id AS sandboxId FROM repository_previews WHERE id = ? AND generation = ? AND status = 'provisioning'",
  ).bind(previewId, generation).first<{ sessionId: string; sandboxId: string | null }>();
  if (!row) return null;
  const now = Date.now();
  const update = await database.prepare(
    `UPDATE repository_previews SET status = 'failed', pending_sandbox_id = NULL,
            failure_reason = ?, updated_at = ? WHERE id = ? AND generation = ? AND status = 'provisioning'`,
  ).bind(reason.slice(0, MAX_PREVIEW_FAILURE_CHARS), now, previewId, generation).run();
  if (!update.meta?.changes) return null;
  if (row.sandboxId) await enqueueSandboxCleanup([row.sandboxId], database, now);
  return { sessionId: row.sessionId, revision: await bumpFloorRevision(row.sessionId, now, database), sandboxId: row.sandboxId };
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
  const sandboxIds = [...new Set([row.pendingSandboxId, row.activeSandboxId].filter((id): id is string => Boolean(id)))];
  await enqueueSandboxCleanup(sandboxIds, database, now);
  const revision = await bumpFloorRevision(sessionId, now, database);
  return { revision, sandboxIds };
}

export async function getPreviewProxyContext(
  host: string,
  userId: string,
  earlyAccessRequired: boolean,
  database = getDb(),
) {
  return database.prepare(
    `SELECT p.session_id AS sessionId, p.active_sandbox_id AS sandboxId
     FROM repository_previews p
     JOIN sessions s ON s.id = p.session_id AND s.ended_at IS NULL
     JOIN repository_connections rc ON rc.session_id = p.session_id AND rc.status = 'ready'
     JOIN repository_candidates c ON c.id = p.candidate_id AND c.status = 'active'
       AND c.merged_at IS NULL AND c.abandoned_at IS NULL
     JOIN session_members sm ON sm.session_id = p.session_id AND sm.user_id = ? AND sm.removed_at IS NULL
     JOIN users u ON u.id = sm.user_id AND u.deleted_at IS NULL
     WHERE p.active_host = ? AND p.active_sandbox_id IS NOT NULL AND p.active_url IS NOT NULL
       AND p.active_candidate_sha IS NOT NULL
       AND c.candidate_sha = c.remote_candidate_sha
       AND p.status IN ('ready', 'failed', 'provisioning') AND p.expires_at > ?
       AND (? = 0 OR (u.early_access_granted_at IS NOT NULL AND u.early_access_revoked_at IS NULL))`,
  ).bind(userId, host.toLowerCase(), Date.now(), earlyAccessRequired ? 1 : 0)
    .first<{ sessionId: string; sandboxId: string }>();
}

export async function getPreviewMemberUserId(providerUserId: string, email: string, database = getDb()): Promise<string | null> {
  const row = await database.prepare(
    "SELECT id FROM users WHERE (chatgpt_user_id = ? OR email = ?) AND deleted_at IS NULL LIMIT 1",
  ).bind(providerUserId, email).first<{ id: string }>();
  return row?.id ?? null;
}

export async function takeExpiredRepositoryPreviews(database = getDb()): Promise<Array<{ sessionId: string; sandboxIds: string[]; revision: number }>> {
  const now = Date.now();
  const rows = await database.prepare(
    `SELECT session_id AS sessionId, generation FROM repository_previews
     WHERE status != 'stopped' AND expires_at <= ? ORDER BY expires_at LIMIT 25`,
  ).bind(now).all<{ sessionId: string; generation: number }>();
  const output: Array<{ sessionId: string; sandboxIds: string[]; revision: number }> = [];
  for (const row of rows.results) {
    const stopped = await stopRepositoryPreview(row.sessionId, database, row.generation);
    if (stopped) output.push({ sessionId: row.sessionId, ...stopped });
  }
  return output;
}

export async function enqueueSandboxCleanup(
  sandboxIds: string[],
  database = getDb(),
  now = Date.now(),
): Promise<void> {
  const ids = [...new Set(sandboxIds.filter(Boolean))];
  if (!ids.length) return;
  await database.batch(ids.map((sandboxId) => database.prepare(
    `INSERT INTO sandbox_cleanup_intents
       (sandbox_id, kind, attempts, not_before, created_at, updated_at)
     VALUES (?, 'repository_preview', 0, ?, ?, ?)
     ON CONFLICT(sandbox_id) DO UPDATE SET not_before = MIN(not_before, excluded.not_before), updated_at = excluded.updated_at`,
  ).bind(sandboxId, now, now, now)));
}

export async function takeDueSandboxCleanup(database = getDb(), now = Date.now()): Promise<string[]> {
  const rows = await database.prepare(
    "SELECT sandbox_id AS sandboxId FROM sandbox_cleanup_intents WHERE not_before <= ? ORDER BY not_before LIMIT 25",
  ).bind(now).all<{ sandboxId: string }>();
  return rows.results.map((row) => row.sandboxId);
}

export async function finishSandboxCleanup(sandboxId: string, database = getDb()): Promise<void> {
  await database.prepare("DELETE FROM sandbox_cleanup_intents WHERE sandbox_id = ?").bind(sandboxId).run();
}

export async function retrySandboxCleanup(sandboxId: string, error: string, database = getDb()): Promise<void> {
  const now = Date.now();
  await database.prepare(
    `UPDATE sandbox_cleanup_intents SET attempts = attempts + 1, not_before = ?, last_error = ?, updated_at = ?
     WHERE sandbox_id = ?`,
  ).bind(now + SANDBOX_CLEANUP_RETRY_MS, error.slice(0, 1_000), now, sandboxId).run();
}

async function bumpFloorRevision(sessionId: string, now: number, database: D1DatabaseLike): Promise<number> {
  await database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?")
    .bind(now, sessionId).run();
  const row = await database.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?")
    .bind(sessionId).first<{ revision: number }>();
  return Number(row?.revision ?? 0);
}
