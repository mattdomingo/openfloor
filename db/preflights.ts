import type { RepositoryPreflight, RepositoryPreflightCheck, RepositoryPreflightStatus } from "@/lib/session-types";
import { getDb, type D1DatabaseLike } from "./index";
import { getMembershipRole } from "./sessions";

export class PreflightConflictError extends Error {}
export class PreflightNotReadyError extends Error {}

type PreflightRecord = Omit<RepositoryPreflight, "checks">;
type CheckRecord = Omit<RepositoryPreflightCheck, "hasLog"> & { logKey: string | null };

export async function getLatestRepositoryPreflightForMember(
  sessionId: string,
  userId: string,
  database = getDb(),
): Promise<RepositoryPreflight | null> {
  if (!(await getMembershipRole(sessionId, userId, database))) return null;
  return getLatestRepositoryPreflight(sessionId, database);
}

export async function getLatestRepositoryPreflight(
  sessionId: string,
  database = getDb(),
): Promise<RepositoryPreflight | null> {
  const record = await database.prepare(
    `SELECT id, session_id AS sessionId, candidate_id AS candidateId, candidate_sha AS candidateSha,
            status, summary, created_by AS createdBy, created_at AS createdAt, started_at AS startedAt,
            completed_at AS completedAt, updated_at AS updatedAt
     FROM repository_preflights WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
  ).bind(sessionId).first<PreflightRecord>();
  if (!record) return null;
  return { ...record, checks: await getPreflightChecks(record.id, database) };
}

export async function createRepositoryPreflight(
  sessionId: string,
  userId: string,
  database = getDb(),
): Promise<RepositoryPreflight> {
  if ((await getMembershipRole(sessionId, userId, database)) !== "owner") throw new PreflightNotReadyError("Session not found");
  const context = await database.prepare(
    `SELECT rc.id AS connectionId, rc.status AS connectionStatus, c.id AS candidateId,
            c.candidate_sha AS candidateSha, c.remote_candidate_sha AS remoteCandidateSha
     FROM repository_connections rc
     LEFT JOIN repository_candidates c ON c.session_id = rc.session_id AND c.status = 'active'
     WHERE rc.session_id = ?`,
  ).bind(sessionId).first<{ connectionId: string; connectionStatus: string; candidateId: string | null; candidateSha: string | null; remoteCandidateSha: string | null }>();
  if (!context || context.connectionStatus !== "ready" || !context.candidateId || !context.candidateSha || context.remoteCandidateSha !== context.candidateSha) {
    throw new PreflightNotReadyError("Synchronize a ready, unmodified candidate before verifying the runner");
  }
  const commands = await database.prepare(
    `SELECT command, position FROM repository_check_commands WHERE connection_id = ? ORDER BY position`,
  ).bind(context.connectionId).all<{ command: string; position: number }>();
  if (commands.results.length === 0) throw new PreflightNotReadyError("Configure at least one required check command before verifying the runner");
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    await database.batch([
      database.prepare(
        `INSERT INTO repository_preflights
         (id, session_id, connection_id, candidate_id, candidate_sha, workflow_instance_id, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'provisioning', ?, ?, ?)`,
      ).bind(id, sessionId, context.connectionId, context.candidateId, context.candidateSha, id, userId, now, now),
      ...commands.results.map((item) => database.prepare(
        `INSERT INTO repository_preflight_checks
         (id, preflight_id, position, command, status, updated_at) VALUES (?, ?, ?, ?, 'pending', ?)`,
      ).bind(crypto.randomUUID(), id, Number(item.position), item.command, now)),
      database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?").bind(now, sessionId),
    ]);
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) throw new PreflightConflictError("A repository preflight is already running");
    throw error;
  }
  return (await getLatestRepositoryPreflight(sessionId, database))!;
}

export async function getPreflightExecutionContext(preflightId: string, database = getDb()) {
  const preflight = await database.prepare(
    `SELECT p.id, p.session_id AS sessionId, p.candidate_sha AS candidateSha, p.status,
            rc.installation_id AS installationId, rc.repository_id AS repositoryId,
            rc.repository_owner AS repositoryOwner, rc.repository_name AS repositoryName
     FROM repository_preflights p
     JOIN repository_connections rc ON rc.id = p.connection_id
     WHERE p.id = ?`,
  ).bind(preflightId).first<{
    id: string; sessionId: string; candidateSha: string; status: RepositoryPreflightStatus;
    installationId: string; repositoryId: string; repositoryOwner: string; repositoryName: string;
  }>();
  if (!preflight) return null;
  const checks = await database.prepare(
    `SELECT id, position, command FROM repository_preflight_checks WHERE preflight_id = ? ORDER BY position`,
  ).bind(preflightId).all<{ id: string; position: number; command: string }>();
  return { ...preflight, checks: checks.results.map((check) => ({ ...check, position: Number(check.position) })) };
}

export async function markPreflightRunning(preflightId: string, database = getDb()): Promise<void> {
  const now = Date.now();
  await database.prepare(
    `UPDATE repository_preflights SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
     WHERE id = ? AND status IN ('provisioning', 'running')`,
  ).bind(now, now, preflightId).run();
}

export async function markPreflightCheckRunning(preflightId: string, checkId: string, database = getDb()): Promise<void> {
  const now = Date.now();
  await database.prepare(
    `UPDATE repository_preflight_checks SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
     WHERE id = ? AND preflight_id = ?`,
  ).bind(now, now, checkId, preflightId).run();
}

export async function finishPreflightCheck(
  preflightId: string,
  checkId: string,
  result: { status: "passed" | "failed" | "timed_out"; exitCode: number | null; durationMs: number; outputExcerpt: string; logKey: string },
  database = getDb(),
): Promise<void> {
  const now = Date.now();
  await database.prepare(
    `UPDATE repository_preflight_checks SET status = ?, exit_code = ?, duration_ms = ?, output_excerpt = ?,
            log_key = ?, completed_at = ?, updated_at = ? WHERE id = ? AND preflight_id = ?`,
  ).bind(result.status, result.exitCode, result.durationMs, result.outputExcerpt, result.logKey, now, now, checkId, preflightId).run();
}

export async function finishRepositoryPreflight(
  preflightId: string,
  status: Extract<RepositoryPreflightStatus, "passed" | "failed" | "cancelled" | "timed_out">,
  summary: string,
  database = getDb(),
): Promise<{ sessionId: string; revision: number } | null> {
  const row = await database.prepare("SELECT session_id AS sessionId FROM repository_preflights WHERE id = ?").bind(preflightId).first<{ sessionId: string }>();
  if (!row) return null;
  const now = Date.now();
  await database.batch([
    database.prepare(
      `UPDATE repository_preflights SET status = ?, summary = ?, completed_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('provisioning', 'running')`,
    ).bind(status, summary.slice(0, 1000), now, now, preflightId),
    database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?").bind(now, row.sessionId),
  ]);
  const revision = await database.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?").bind(row.sessionId).first<{ revision: number }>();
  return { sessionId: row.sessionId, revision: Number(revision?.revision ?? 0) };
}

export async function markPreflightLaunchFailed(preflightId: string, message: string, database = getDb()): Promise<void> {
  await finishRepositoryPreflight(preflightId, "failed", message, database);
}

export async function getPreflightLogKeysForMember(
  sessionId: string,
  preflightId: string,
  userId: string,
  database = getDb(),
): Promise<Array<{ position: number; command: string; logKey: string }> | null> {
  if (!(await getMembershipRole(sessionId, userId, database))) return null;
  const result = await database.prepare(
    `SELECT c.position, c.command, c.log_key AS logKey
     FROM repository_preflight_checks c JOIN repository_preflights p ON p.id = c.preflight_id
     WHERE p.id = ? AND p.session_id = ? AND c.log_key IS NOT NULL ORDER BY c.position`,
  ).bind(preflightId, sessionId).all<{ position: number; command: string; logKey: string }>();
  return result.results.map((item) => ({ ...item, position: Number(item.position) }));
}

async function getPreflightChecks(preflightId: string, database: D1DatabaseLike): Promise<RepositoryPreflightCheck[]> {
  const result = await database.prepare(
    `SELECT id, position, command, status, exit_code AS exitCode, duration_ms AS durationMs,
            output_excerpt AS outputExcerpt, log_key AS logKey, started_at AS startedAt,
            completed_at AS completedAt
     FROM repository_preflight_checks WHERE preflight_id = ? ORDER BY position`,
  ).bind(preflightId).all<CheckRecord>();
  return result.results.map(({ logKey, ...check }) => ({ ...check, position: Number(check.position), hasLog: Boolean(logKey) }));
}
