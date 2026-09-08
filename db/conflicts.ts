import { queueAgentAccessError } from "./agent-access";
import type { ConflictChoice, MergeConflictCase, MergeConflictQuestion } from "@/lib/floor-types";
import type { CredentialProvider } from "@/lib/provider-credentials";
import { getDb } from "./index";
import { getActiveMembershipRole, getMembershipRole } from "./sessions";

import { getConflictResolutionViews, refreshConflictSnapshot, getConflictDecisionView } from "./conflict-decisions";
import { MAX_AUTOMATIC_CONFLICT_ATTEMPTS, type ConflictMode } from "@/lib/conflict-resolution";

export { MAX_AUTOMATIC_CONFLICT_ATTEMPTS } from "@/lib/conflict-resolution";

type CaseRow = Omit<MergeConflictCase, "conflictPaths" | "questions" | "prompts" | "attempts" | "hasSnapshot" | "resolution"> & { conflictPaths: string; hasSnapshot: number };

function paths(value: string | null): string[] {
  try {
    const parsed = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export async function getMergeConflictCases(sessionId: string, database = getDb()): Promise<MergeConflictCase[]> {
  const rows = await database.prepare(
    `SELECT mc.id, mc.status, mc.source_run_id AS sourceRunId, mc.latest_source_run_id AS latestSourceRunId,
            mc.current_resolver_run_id AS currentResolverRunId, source.queue_item_id AS queueItemId,
            source.agent_id AS agentId, a.name AS agentName,
            COALESCE(source.conflict_reason, 'The run conflicts with the latest candidate branch.') AS conflictReason,
            mc.explanation, mc.conflict_paths AS conflictPaths, mc.automatic_attempts AS automaticAttempts,
            mc.failure_reason AS failureReason, mc.created_at AS createdAt, mc.updated_at AS updatedAt,
            mc.resolved_at AS resolvedAt,
            EXISTS (
              SELECT 1 FROM merge_conflict_attempts mca JOIN agent_run_artifacts ar
                ON ar.run_id = mca.run_id AND ar.kind = 'conflict_snapshot'
              WHERE mca.case_id = mc.id
            ) AS hasSnapshot
     FROM merge_conflict_cases mc
     JOIN agent_runs source ON source.id = mc.source_run_id
     JOIN floor_agents a ON a.id = source.agent_id
     WHERE mc.session_id = ? ORDER BY mc.updated_at DESC, mc.id DESC`,
  ).bind(sessionId).all<CaseRow>();
  const questions = await database.prepare(
    `SELECT q.id, q.case_id AS caseId, q.question, q.answer, q.answered_by AS answeredByUserId,
            u.display_name AS answeredByName, q.requested_at AS requestedAt, q.answered_at AS answeredAt
     FROM merge_conflict_questions q
     LEFT JOIN users u ON u.id = q.answered_by
     JOIN merge_conflict_cases mc ON mc.id = q.case_id
     WHERE mc.session_id = ? ORDER BY q.requested_at, q.position, q.id`,
  ).bind(sessionId).all<MergeConflictQuestion & { caseId: string }>();
  const byCase = new Map<string, MergeConflictQuestion[]>();
  for (const { caseId, ...question } of questions.results) {
    const list = byCase.get(caseId) ?? [];
    list.push({ ...question, answer: question.answer ?? null, answeredByUserId: question.answeredByUserId ?? null,
      answeredByName: question.answeredByName ?? null, answeredAt: question.answeredAt ?? null });
    byCase.set(caseId, list);
  }
  const promptRows = await database.prepare(
    `SELECT mc.id AS caseId, p.id, p.author_user_id AS authorUserId, u.display_name AS authorName, p.text
     FROM merge_conflict_cases mc JOIN agent_runs source ON source.id = mc.source_run_id
     JOIN floor_queue_prompts p ON p.queue_item_id = source.queue_item_id JOIN users u ON u.id = p.author_user_id
     WHERE mc.session_id = ? ORDER BY p.created_at, p.id`,
  ).bind(sessionId).all<{ caseId: string; id: string; authorUserId: string; authorName: string; text: string }>();
  const promptsByCase = new Map<string, MergeConflictCase["prompts"]>();
  for (const { caseId, ...prompt } of promptRows.results) {
    const list = promptsByCase.get(caseId) ?? [];
    list.push(prompt);
    promptsByCase.set(caseId, list);
  }
  const attemptRows = await database.prepare(
    `SELECT mca.case_id AS caseId, r.id AS runId, mca.launch_kind AS launchKind, r.status, r.summary,
            r.created_at AS createdAt, r.completed_at AS completedAt, arc.command AS checkCommand, arc.status AS checkStatus
     FROM merge_conflict_attempts mca JOIN merge_conflict_cases mc ON mc.id = mca.case_id
     JOIN agent_runs r ON r.id = mca.run_id LEFT JOIN agent_run_checks arc ON arc.run_id = r.id
     WHERE mc.session_id = ? ORDER BY r.created_at, r.id, arc.position`,
  ).bind(sessionId).all<{
    caseId: string; runId: string; launchKind: "automatic" | "manual" | "answer"; status: import("@/lib/floor-types").AgentRunStatus;
    summary: string | null; createdAt: number; completedAt: number | null; checkCommand: string | null;
    checkStatus: import("@/lib/floor-types").AgentRunCheck["status"] | null;
  }>();
  const attemptsByCase = new Map<string, MergeConflictCase["attempts"]>();
  for (const row of attemptRows.results) {
    const list = attemptsByCase.get(row.caseId) ?? [];
    let attempt = list.find((item) => item.runId === row.runId);
    if (!attempt) {
      attempt = { runId: row.runId, launchKind: row.launchKind, status: row.status, summary: row.summary ?? null,
        createdAt: Number(row.createdAt), completedAt: row.completedAt ?? null, checks: [] };
      list.push(attempt);
    }
    if (row.checkCommand && row.checkStatus) attempt.checks.push({ command: row.checkCommand, status: row.checkStatus });
    attemptsByCase.set(row.caseId, list);
  }
  const resolutions = await getConflictResolutionViews(sessionId, database);
  return rows.results.map((row) => ({
    ...row,
    resolution: resolutions.get(row.id) ?? null,
    currentResolverRunId: row.currentResolverRunId ?? null,
    explanation: row.explanation ?? null,
    conflictPaths: paths(row.conflictPaths),
    automaticAttempts: Number(row.automaticAttempts),
    failureReason: row.failureReason ?? null,
    resolvedAt: row.resolvedAt ?? null,
    hasSnapshot: Boolean(row.hasSnapshot),
    questions: byCase.get(row.id) ?? [],
    prompts: promptsByCase.get(row.id) ?? [],
    attempts: attemptsByCase.get(row.id) ?? [],
  }));
}

/** Shared authorization for the "human decision" surfaces (free-text answers
 * and, now, per-hunk selections): the session owner, or a user who authored
 * at least one prompt on the case's original source queue item. Returns the
 * active membership role ("missing" callers get a concealed 404), or null
 * when the caller has no access at all. */
async function authorizeConflictDecision(sessionId: string, caseId: string, userId: string, database: ReturnType<typeof getDb>): Promise<boolean> {
  const role = await getActiveMembershipRole(sessionId, userId, database);
  if (!role) return false;
  const boundCase = await database.prepare("SELECT 1 AS present FROM merge_conflict_cases WHERE id = ? AND session_id = ?")
    .bind(caseId, sessionId).first();
  if (!boundCase) return false;
  if (role === "owner") return true;
  const authored = await database.prepare(
    `SELECT 1 AS allowed FROM merge_conflict_cases mc
     JOIN agent_runs source ON source.id = mc.source_run_id
     JOIN floor_queue_prompts p ON p.queue_item_id = source.queue_item_id
     WHERE mc.id = ? AND mc.session_id = ? AND p.author_user_id = ? LIMIT 1`,
  ).bind(caseId, sessionId, userId).first<{ allowed: number }>();
  return Boolean(authored);
}

/** The resolver attempt whose conflict_snapshot artifact is current for a
 * case — always the most recently captured one, since every attempt (manual
 * or automatic) captures its own. Null means no attempt has ever produced a
 * snapshot (nothing for the manual dialog to show yet). */
async function getLatestConflictSnapshotRunId(caseId: string, database: ReturnType<typeof getDb>): Promise<string | null> {
  const row = await database.prepare(
    `SELECT mca.run_id AS runId FROM merge_conflict_attempts mca
     JOIN agent_run_artifacts ar ON ar.run_id = mca.run_id AND ar.kind = 'conflict_snapshot'
     WHERE mca.case_id = ? ORDER BY ar.created_at DESC, mca.run_id DESC LIMIT 1`,
  ).bind(caseId).first<{ runId: string }>();
  return row?.runId ?? null;
}

export type ConflictSnapshotArtifactAccess = {
  runId: string;
  r2Key: string;
  conflictPaths: string[];
  existingSelections: Array<{ path: string; hunkIndex: number; choice: ConflictChoice }>;
};

/** Authorizes and locates the R2 object for a case's current snapshot, plus
 * any selections already recorded against it (so a reopened dialog can
 * prefill). Route-layer reads the R2 body itself (db/ stays D1-only, same
 * split as every other run-artifact route). */
export async function getConflictSnapshotArtifact(sessionId: string, caseId: string, userId: string, database = getDb()): Promise<ConflictSnapshotArtifactAccess | "forbidden" | "not_found"> {
  if (!(await authorizeConflictDecision(sessionId, caseId, userId, database))) return "forbidden";
  const runId = await getLatestConflictSnapshotRunId(caseId, database);
  if (!runId) return "not_found";
  const artifact = await database.prepare(
    "SELECT r2_key AS r2Key FROM agent_run_artifacts WHERE run_id = ? AND kind = 'conflict_snapshot'",
  ).bind(runId).first<{ r2Key: string }>();
  if (!artifact) return "not_found";
  const [caseRow, selections] = await Promise.all([
    database.prepare("SELECT conflict_paths AS conflictPaths FROM merge_conflict_cases WHERE id = ?").bind(caseId).first<{ conflictPaths: string }>(),
    database.prepare(
      "SELECT path, hunk_index AS hunkIndex, choice FROM merge_conflict_selections WHERE snapshot_run_id = ? ORDER BY path, hunk_index",
    ).bind(runId).all<{ path: string; hunkIndex: number; choice: string }>(),
  ]);
  return {
    runId, r2Key: artifact.r2Key,
    conflictPaths: paths(caseRow?.conflictPaths ?? null),
    existingSelections: selections.results.map((row) => ({ path: row.path, hunkIndex: Number(row.hunkIndex), choice: row.choice as ConflictChoice })),
  };
}

export type ConflictSelectionInput = { path: string; hunkIndex: number; choice: ConflictChoice };

/** Records one human's complete set of per-hunk choices for the case's
 * current snapshot and resumes the case for a deterministic resolver
 * attempt — same authorization and "first complete submission against the
 * current snapshot wins" staleness rule as answerConflictQuestions. The
 * caller (the API route) is responsible for having already verified that
 * `selections` covers every hunk the snapshot actually has; this function
 * only re-derives "is snapshotRunId still current" atomically against the
 * write, which a route-layer check alone cannot guarantee under a race. */
export async function recordConflictSelections(
  sessionId: string,
  caseId: string,
  userId: string,
  snapshotRunId: string,
  selections: ConflictSelectionInput[],
  database = getDb(),
): Promise<"recorded" | "stale" | "missing"> {
  if (!(await authorizeConflictDecision(sessionId, caseId, userId, database))) return "missing";
  const exists = await database.prepare("SELECT id FROM merge_conflict_cases WHERE id = ? AND session_id = ?")
    .bind(caseId, sessionId).first<{ id: string }>();
  if (!exists) return "missing";
  const now = Date.now();
  const latestSnapshotSubquery = `(
    SELECT mca.run_id FROM merge_conflict_attempts mca
    JOIN agent_run_artifacts ar ON ar.run_id = mca.run_id AND ar.kind = 'conflict_snapshot'
    WHERE mca.case_id = ? ORDER BY ar.created_at DESC, mca.run_id DESC LIMIT 1
  )`;
  const statements = selections.map((selection) => database.prepare(
    `INSERT INTO merge_conflict_selections (id, case_id, snapshot_run_id, path, hunk_index, choice, selected_by, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ? = ${latestSnapshotSubquery}
       AND EXISTS (SELECT 1 FROM merge_conflict_cases WHERE id = ? AND status IN ('failed', 'awaiting_input') AND current_resolver_run_id IS NULL)
     ON CONFLICT(snapshot_run_id, path, hunk_index) DO UPDATE SET
       choice = excluded.choice, selected_by = excluded.selected_by, created_at = excluded.created_at`,
  ).bind(crypto.randomUUID(), caseId, snapshotRunId, selection.path, selection.hunkIndex, selection.choice, userId, now, snapshotRunId, caseId, caseId));
  const results = await database.batch([
    ...statements,
    database.prepare(
      `UPDATE merge_conflict_cases SET status = 'pending', resume_requested = 1, failure_reason = NULL,
              current_resolver_run_id = NULL, updated_at = ?
       WHERE id = ? AND session_id = ? AND status IN ('failed', 'awaiting_input') AND ? = ${latestSnapshotSubquery}`,
    ).bind(now, caseId, sessionId, snapshotRunId, caseId),
    database.prepare(
      `UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ?
       WHERE id = ? AND changes() = 1`,
    ).bind(now, sessionId),
  ]);
  const caseChanges = Number(results[statements.length]?.meta?.changes ?? 0) === 1;
  return caseChanges ? "recorded" : "stale";
}

/** What a resolver run should deterministically apply instead of invoking an
 * agent — the case's current snapshot's selections, if any exist. Null means
 * either no manual selections were ever recorded (an ordinary automatic
 * attempt) or the case has no snapshot at all; the workflow falls back to
 * running the agent normally in both cases. */
export async function getConflictSelectionsForCase(
  caseId: string,
  database = getDb(),
): Promise<{ snapshotRunId: string; selections: ConflictSelectionInput[] } | null> {
  const snapshotRunId = await getLatestConflictSnapshotRunId(caseId, database);
  if (!snapshotRunId) return null;
  const rows = await database.prepare(
    "SELECT path, hunk_index AS hunkIndex, choice FROM merge_conflict_selections WHERE snapshot_run_id = ? ORDER BY path, hunk_index",
  ).bind(snapshotRunId).all<{ path: string; hunkIndex: number; choice: string }>();
  if (rows.results.length === 0) return null;
  return { snapshotRunId, selections: rows.results.map((row) => ({ path: row.path, hunkIndex: Number(row.hunkIndex), choice: row.choice as ConflictChoice })) };
}

/** Creates one stable case for an original conflict, or advances the same
 * case when a resolver result itself conflicts after the candidate moved. */
export async function recordIntegrationConflict(runId: string, reason: string, database = getDb(), overlap: { trigger: "git" | "overlap"; paths: string[] } = { trigger: "git", paths: [] }): Promise<{ sessionId: string; caseId: string } | null> {
  const row = await database.prepare(
    `SELECT r.session_id AS sessionId, mca.case_id AS existingCaseId,
            s.auto_resolve_conflicts AS autoResolve, mc.automatic_attempts AS automaticAttempts
     FROM agent_runs r
     JOIN sessions s ON s.id = r.session_id
     LEFT JOIN merge_conflict_attempts mca ON mca.run_id = r.id
     LEFT JOIN merge_conflict_cases mc ON mc.id = mca.case_id
     WHERE r.id = ? AND r.status = 'conflicted'`,
  ).bind(runId).first<{ sessionId: string; existingCaseId: string | null; autoResolve: number; automaticAttempts: number | null }>();
  if (!row) return null;
  const now = Date.now();
  if (row.existingCaseId) {
    const retry = true; // Preparation is deterministic and independent of AI automation.
    await database.prepare(
      `UPDATE merge_conflict_cases SET latest_source_run_id = source_run_id, current_resolver_run_id = NULL,
              status = ?, mode = 'prepare', automatic_attempts = 0, snapshot_id = NULL, proposal_id = NULL, revision = revision + 1, failure_reason = ?, updated_at = ? WHERE id = ? AND current_resolver_run_id = ?`,
    ).bind(retry ? "pending" : "failed", retry ? null : reason.slice(0, 2_000), now, row.existingCaseId, runId).run();
    await database.prepare("UPDATE floor_queue_items SET status = 'blocked', updated_at = ? WHERE id = (SELECT queue_item_id FROM agent_runs WHERE id = ?)")
      .bind(now, runId).run();
    return { sessionId: row.sessionId, caseId: row.existingCaseId };
  }
  const id = crypto.randomUUID();
  await database.prepare(
    `INSERT INTO merge_conflict_cases
       (id, session_id, source_run_id, latest_source_run_id, status, explanation, conflict_paths,
        automatic_attempts, resume_requested, failure_reason, trigger, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, 0, 0, NULL, ?, ?, ?)
     ON CONFLICT(source_run_id) DO NOTHING`,
  ).bind(id, row.sessionId, runId, runId, reason.slice(0, 4_000), JSON.stringify(overlap.paths), overlap.trigger, now, now).run();
  const existing = await database.prepare("SELECT id FROM merge_conflict_cases WHERE source_run_id = ?")
    .bind(runId).first<{ id: string }>();
  return existing ? { sessionId: row.sessionId, caseId: existing.id } : null;
}

export type PendingConflict = {
  id: string;
  sessionId: string;
  agentId: string;
  agentProvider: CredentialProvider;
  status: "pending" | "failed";
  automaticAttempts: number;
  resumeRequested: boolean;
  autoResolve: boolean;
  mode: ConflictMode;
};

export async function getPendingConflicts(sessionId: string, database = getDb()): Promise<PendingConflict[]> {
  const rows = await database.prepare(
    `SELECT mc.id, mc.session_id AS sessionId, source.agent_id AS agentId, a.provider AS agentProvider,
            mc.status, mc.mode, mc.automatic_attempts AS automaticAttempts, mc.resume_requested AS resumeRequested,
            s.auto_resolve_conflicts AS autoResolve
     FROM merge_conflict_cases mc JOIN sessions s ON s.id = mc.session_id
     JOIN agent_runs source ON source.id = mc.latest_source_run_id JOIN floor_agents a ON a.id = source.agent_id
     WHERE mc.session_id = ? AND mc.status IN ('pending', 'failed') AND mc.current_resolver_run_id IS NULL
       AND (mc.resume_requested = 1 OR (mc.mode = 'prepare' AND mc.status = 'pending')
         OR (s.auto_resolve_conflicts = 1 AND mc.status = 'pending' AND mc.automatic_attempts < ?))
     ORDER BY mc.updated_at, mc.id LIMIT 100`,
  ).bind(sessionId, MAX_AUTOMATIC_CONFLICT_ATTEMPTS).all<Omit<PendingConflict, "autoResolve" | "resumeRequested"> & { autoResolve: number; resumeRequested: number }>();
  return rows.results.map((row) => ({ ...row, autoResolve: Boolean(row.autoResolve), resumeRequested: Boolean(row.resumeRequested), automaticAttempts: Number(row.automaticAttempts) }));
}
export async function getPendingConflict(sessionId: string, database = getDb()): Promise<PendingConflict | null> {
  return (await getPendingConflicts(sessionId, database))[0] ?? null;
}

export async function createConflictResolverRun(
  caseId: string,
  launchKind: "automatic" | "manual" | "answer",
  database = getDb(),
): Promise<{ runId: string; sessionId: string; agentId: string } | null> {
  const context = await database.prepare(
    `SELECT mc.session_id AS sessionId, mc.status, mc.resume_requested AS resumeRequested,
            mc.automatic_attempts AS automaticAttempts, s.auto_resolve_conflicts AS autoResolve,
            mc.mode, mc.snapshot_id AS snapshotId, mc.proposal_id AS proposalId, mc.revision, mc.latest_source_run_id AS sourceRunId,
            source.queue_item_id AS queueItemId, source.agent_id AS agentId, source.model, source.attribution,
            rc.status AS connectionStatus,
            c.id AS candidateId, c.candidate_sha AS candidateSha, c.remote_candidate_sha AS remoteCandidateSha,
            owner.user_id AS ownerId
     FROM merge_conflict_cases mc
     JOIN sessions s ON s.id = mc.session_id AND s.ended_at IS NULL
     JOIN agent_runs source ON source.id = mc.latest_source_run_id
     JOIN repository_candidates c ON c.session_id = mc.session_id AND c.status = 'active' AND c.merged_at IS NULL
     JOIN repository_connections rc ON rc.id = c.connection_id
     JOIN session_members owner ON owner.session_id = mc.session_id AND owner.role = 'owner' AND owner.removed_at IS NULL
     WHERE mc.id = ? AND mc.current_resolver_run_id IS NULL AND mc.status IN ('pending', 'failed')`,
  ).bind(caseId).first<{
    sessionId: string; status: string; resumeRequested: number; automaticAttempts: number; autoResolve: number;
    mode: ConflictMode; snapshotId: string | null; proposalId: string | null; revision: number; sourceRunId: string;
    attribution: string | null; queueItemId: string; agentId: string; model: string; connectionStatus: string;
    candidateId: string; candidateSha: string; remoteCandidateSha: string; ownerId: string;
  }>();
  if (!context || context.connectionStatus !== "ready" || context.candidateSha !== context.remoteCandidateSha) return null;
  if (context.mode === "ai" && await queueAgentAccessError(context.sessionId, context.queueItemId, database)) return null;
  if (context.mode === "ai" && (context.automaticAttempts >= MAX_AUTOMATIC_CONFLICT_ATTEMPTS || launchKind === "automatic" && !context.autoResolve)) return null;
  if (context.mode !== "prepare" && launchKind !== "automatic" && !context.resumeRequested) return null;
  if (context.mode !== "prepare") {
    const resolution = (await getConflictResolutionViews(context.sessionId, database)).get(caseId);
    if (!resolution?.snapshotId || resolution.candidateSha !== context.candidateSha) {
      await refreshConflictSnapshot(context.sessionId, caseId, null, database);
      return null;
    }
    if (context.proposalId && !resolution.proposal?.approved || context.mode === "manual" && !resolution.proposal?.approved) return null;
  }
  const previous = await database.prepare("SELECT COALESCE(MAX(attempt), 0) AS attempt FROM agent_runs WHERE queue_item_id = ?")
    .bind(context.queueItemId).first<{ attempt: number }>();
  const attempt = Number(previous?.attempt ?? 0) + 1;
  const runId = crypto.randomUUID();
  const now = Date.now();
  const runBranch = `openfloor/${context.sessionId.slice(0, 8)}/run/${runId.slice(0, 8)}`;
  try {
    await database.batch([
      database.prepare(
        `INSERT INTO agent_runs
         (id, session_id, queue_item_id, agent_id, candidate_id, candidate_sha, run_branch, attempt, status, model,
          workflow_instance_id, sandbox_id, created_by, created_at, updated_at, attribution)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'provisioning', ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM merge_conflict_cases WHERE id = ? AND revision = ? AND current_resolver_run_id IS NULL AND status IN ('pending', 'failed'))`,
      ).bind(runId, context.sessionId, context.queueItemId, context.agentId, context.candidateId, context.candidateSha,
        runBranch, attempt, context.model, runId, `run-${runId}`, context.ownerId, now, now, context.attribution, caseId, context.revision),
      database.prepare(
        `INSERT INTO merge_conflict_attempts (id, case_id, run_id, launch_kind, execution_mode, snapshot_id, proposal_id, source_run_id, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM agent_runs WHERE id = ?)`,
      ).bind(crypto.randomUUID(), caseId, runId, launchKind, context.mode, context.snapshotId, context.proposalId, context.sourceRunId, now, runId),
      database.prepare(`INSERT INTO agent_run_checks (id, run_id, position, command, status, updated_at)
        SELECT ? || ':' || position, ?, position, command, 'pending', ? FROM agent_run_checks
        WHERE run_id = ? AND ? != 'prepare' AND EXISTS (SELECT 1 FROM agent_runs WHERE id = ?)`)
        .bind(runId, runId, now, context.sourceRunId, context.mode, runId),
      database.prepare(
        `UPDATE merge_conflict_cases SET current_resolver_run_id = ?, status = 'resolving', resume_requested = 0,
                automatic_attempts = automatic_attempts + ?, failure_reason = NULL, waiting_reason = NULL, revision = revision + 1, updated_at = ?
         WHERE id = ? AND EXISTS (SELECT 1 FROM merge_conflict_attempts WHERE run_id = ?)`,
      ).bind(runId, context.mode === "ai" ? 1 : 0, now, caseId, runId),
      database.prepare(
        `UPDATE floor_queue_items SET status = 'running', updated_at = ? WHERE id = ?
         AND EXISTS (SELECT 1 FROM merge_conflict_attempts WHERE run_id = ?)`,
      ).bind(now, context.queueItemId, runId),
      database.prepare(
        `UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?
         AND EXISTS (SELECT 1 FROM merge_conflict_attempts WHERE run_id = ?)`,
      ).bind(now, context.sessionId, runId),
    ]);
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) return null;
    throw error;
  }
  const created = await database.prepare("SELECT id FROM agent_runs WHERE id = ?").bind(runId).first<{ id: string }>();
  if (!created) return null;
  await database.prepare(
    `INSERT INTO agent_run_events (id, run_id, sequence, kind, detail, created_at) VALUES (?, ?, 1, 'queued', ?, ?)`,
  ).bind(crypto.randomUUID(), runId, `Merge Resolver attempt ${attempt} created.`, now).run();
  return { runId, sessionId: context.sessionId, agentId: context.agentId };
}

export async function getConflictRunContext(runId: string, database = getDb()) {
  const row = await database.prepare(
    `SELECT mc.id AS caseId, mc.session_id AS sessionId, source.id AS sourceRunId,
            mc.status, mc.explanation, mc.conflict_paths AS conflictPaths,
            source.candidate_sha AS sourceCandidateSha, source.bundle_key AS sourceBundleKey,
            source.run_branch AS sourceRunBranch, source.local_commit_sha AS sourceLocalCommitSha,
            source.summary AS sourceSummary, source.conflict_reason AS sourceConflictReason,
            resolver.candidate_sha AS resolverCandidateSha, resolver.status AS resolverStatus,
            rc.repository_id AS repositoryId, rc.installation_id AS installationId,
            rc.repository_owner AS repositoryOwner, rc.repository_name AS repositoryName,
            rc.repository_full_name AS repositoryFullName
     FROM merge_conflict_attempts mca
     JOIN merge_conflict_cases mc ON mc.id = mca.case_id
     JOIN agent_runs resolver ON resolver.id = mca.run_id
     JOIN agent_runs source ON source.id = COALESCE(mca.source_run_id, mc.latest_source_run_id)
     JOIN repository_candidates c ON c.id = resolver.candidate_id
     JOIN repository_connections rc ON rc.id = c.connection_id
     WHERE mca.run_id = ?`,
  ).bind(runId).first<{
    caseId: string; sessionId: string; sourceRunId: string; status: string; explanation: string | null; conflictPaths: string;
    sourceCandidateSha: string; sourceBundleKey: string; sourceRunBranch: string; sourceLocalCommitSha: string;
    sourceSummary: string | null; sourceConflictReason: string | null; resolverCandidateSha: string; resolverStatus: string;
    repositoryId: string; installationId: string; repositoryOwner: string; repositoryName: string; repositoryFullName: string;
  }>();
  return row ? { ...row, conflictPaths: paths(row.conflictPaths) } : null;
}

export async function recordConflictPaths(runId: string, conflictPaths: string[], database = getDb()): Promise<void> {
  await database.prepare(
    `UPDATE merge_conflict_cases SET conflict_paths = ?, updated_at = ?
     WHERE current_resolver_run_id = ? AND status = 'resolving'`,
  ).bind(JSON.stringify([...new Set(conflictPaths)].slice(0, 100)), Date.now(), runId).run();
}

export async function requestConflictInput(
  runId: string,
  explanation: string,
  questions: string[],
  database = getDb(),
): Promise<{ sessionId: string; revision: number; caseId: string } | null> {
  const context = await database.prepare(
    `SELECT mc.id AS caseId, mc.session_id AS sessionId, source.queue_item_id AS queueItemId
     FROM merge_conflict_cases mc
     JOIN agent_runs source ON source.id = mc.source_run_id
     JOIN agent_runs resolver ON resolver.id = mc.current_resolver_run_id
     WHERE mc.current_resolver_run_id = ? AND mc.status = 'resolving'
       AND resolver.status IN ('provisioning', 'running', 'checking')`,
  ).bind(runId).first<{ caseId: string; sessionId: string; queueItemId: string }>();
  if (!context) return null;
  const now = Date.now();
  const token = crypto.randomUUID();
  const result = await database.batch([
    database.prepare(`UPDATE merge_conflict_cases SET status = 'awaiting_input', explanation = ?, waiting_reason = 'A product decision requires affected authors to agree.', revision = revision + 1,
      mutation_id = ?, failure_reason = NULL, updated_at = ? WHERE id = ? AND current_resolver_run_id = ? AND status = 'resolving'
      AND EXISTS (SELECT 1 FROM agent_runs r JOIN sessions s ON s.id = r.session_id WHERE r.id = ? AND r.status IN ('provisioning', 'running', 'checking') AND s.ended_at IS NULL)`)
      .bind(explanation, token, now, context.caseId, runId, runId),
    database.prepare(`DELETE FROM merge_conflict_questions WHERE case_id = ? AND answer IS NULL
      AND EXISTS (SELECT 1 FROM merge_conflict_cases WHERE id = ? AND mutation_id = ?)`).bind(context.caseId, context.caseId, token),
    ...questions.map((question, position) => database.prepare(`INSERT INTO merge_conflict_questions (id, case_id, requested_by_run_id, position, question, requested_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM merge_conflict_cases WHERE id = ? AND mutation_id = ?)`)
      .bind(crypto.randomUUID(), context.caseId, runId, position, question, now, context.caseId, token)),
    database.prepare(`UPDATE floor_queue_items SET status = 'blocked', updated_at = ? WHERE id = ?
      AND EXISTS (SELECT 1 FROM merge_conflict_cases WHERE id = ? AND mutation_id = ?)`).bind(now, context.queueItemId, context.caseId, token),
    database.prepare(`UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?
      AND EXISTS (SELECT 1 FROM merge_conflict_cases WHERE id = ? AND mutation_id = ?)`).bind(now, context.sessionId, context.caseId, token),
  ]);
  if (Number(result[0].meta?.changes ?? 0) !== 1) return null;
  const revision = await database.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?")
    .bind(context.sessionId).first<{ revision: number }>();
  return { sessionId: context.sessionId, revision: Number(revision?.revision ?? 0), caseId: context.caseId };
}

export async function isConflictInputRequested(runId: string, database = getDb()): Promise<boolean> {
  const row = await database.prepare(
    `SELECT 1 AS requested FROM merge_conflict_attempts mca JOIN merge_conflict_cases mc ON mc.id = mca.case_id
     WHERE mca.run_id = ? AND mc.current_resolver_run_id = mca.run_id AND mc.status = 'awaiting_input'`,
  ).bind(runId).first<{ requested: number }>();
  return Boolean(row);
}

export async function finishResolverAwaitingInput(runId: string, database = getDb()): Promise<void> {
  const now = Date.now();
  const token = crypto.randomUUID();
  await database.batch([
    database.prepare(`UPDATE merge_conflict_cases SET current_resolver_run_id = NULL, mutation_id = ?,
      revision = revision + 1, updated_at = ? WHERE current_resolver_run_id = ? AND status = 'awaiting_input'
      AND EXISTS (SELECT 1 FROM agent_runs r JOIN sessions s ON s.id = r.session_id
        WHERE r.id = ? AND r.status IN ('provisioning', 'running', 'checking') AND s.ended_at IS NULL)`)
      .bind(token, now, runId, runId),
    database.prepare(`UPDATE agent_runs SET status = 'failed', summary = 'Merge Resolver is waiting for session input.',
      completed_at = ?, updated_at = ? WHERE id = ?
      AND EXISTS (SELECT 1 FROM merge_conflict_cases WHERE mutation_id = ?)`)
      .bind(now, now, runId, token),
    database.prepare(`INSERT INTO agent_run_events (id, run_id, sequence, kind, detail, created_at)
      SELECT ?, ?, COALESCE((SELECT MAX(sequence) FROM agent_run_events WHERE run_id = ?), 0) + 1,
        'awaiting_input', 'Merge Resolver requested session input.', ?
      WHERE EXISTS (SELECT 1 FROM merge_conflict_cases WHERE mutation_id = ?)`)
      .bind(crypto.randomUUID(), runId, runId, now, token),
    database.prepare(`UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ?
      WHERE id = (SELECT session_id FROM merge_conflict_cases WHERE mutation_id = ?)`)
      .bind(now, token),
  ]);
}

export async function advanceConflictAfterFailure(
  runId: string,
  reason: string,
  database = getDb(),
  retryEligible = true,
): Promise<{ sessionId: string; retry: boolean } | null> {
  const row = await database.prepare(
    `SELECT mc.id AS caseId, mc.session_id AS sessionId, mc.automatic_attempts AS automaticAttempts, mca.execution_mode AS executionMode, mca.launch_kind AS launchKind, mca.proposal_id AS proposalId,
            s.auto_resolve_conflicts AS autoResolve, source.queue_item_id AS queueItemId,
            EXISTS (SELECT 1 FROM merge_conflict_selections ms WHERE ms.case_id = mc.id) AS hasHumanSelections
     FROM merge_conflict_attempts mca JOIN merge_conflict_cases mc ON mc.id = mca.case_id
     JOIN sessions s ON s.id = mc.session_id JOIN agent_runs source ON source.id = mc.source_run_id
     WHERE mca.run_id = ? AND mc.current_resolver_run_id = mca.run_id AND mc.status = 'resolving'`,
  ).bind(runId).first<{ caseId: string; sessionId: string; automaticAttempts: number; autoResolve: number; queueItemId: string; hasHumanSelections: number; executionMode: ConflictMode; launchKind: string; proposalId: string | null }>();
  if (!row) return null;
  const retry = row.executionMode === "ai" && retryEligible && (Boolean(row.autoResolve) || row.proposalId !== null || row.launchKind !== "automatic") && Number(row.automaticAttempts) < MAX_AUTOMATIC_CONFLICT_ATTEMPTS;
  const now = Date.now();
  const token = crypto.randomUUID();
  const changed = await database.batch([
    database.prepare(`UPDATE merge_conflict_cases SET current_resolver_run_id = NULL, status = ?, failure_reason = ?, waiting_reason = ?, resume_requested = ?,
      mutation_id = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND current_resolver_run_id = ? AND status = 'resolving'`)
      .bind(retry ? "pending" : "failed", reason.slice(0, 2_000), retry ? "AI will retry with the failure evidence." : "Resolution stopped. Review the error, then propose a new result or retry preparation.", retry ? 1 : 0, token, now, row.caseId, runId),
    database.prepare(`UPDATE floor_queue_items SET status = 'blocked', updated_at = ? WHERE id = ?
      AND EXISTS (SELECT 1 FROM merge_conflict_cases WHERE id = ? AND mutation_id = ?)`).bind(now, row.queueItemId, row.caseId, token),
    database.prepare(`UPDATE sessions SET floor_revision = floor_revision + 1 WHERE id = ?
      AND EXISTS (SELECT 1 FROM merge_conflict_cases WHERE id = ? AND mutation_id = ?)`).bind(row.sessionId, row.caseId, token),
  ]);
  if (Number(changed[0].meta?.changes ?? 0) !== 1) return null;
  return { sessionId: row.sessionId, retry };
}

export async function requestConflictResolution(sessionId: string, caseId: string, userId: string, database = getDb(), revision?: number): Promise<boolean | null> {
  if (!await getActiveMembershipRole(sessionId, userId, database)) return null;
  const view = await getConflictDecisionView(sessionId, caseId, userId, database);
  if (!view?.canPropose) return null;
  if (revision !== view.resolution.revision || view.resolution.proposal && !view.resolution.proposal.approved) return false;
  const now = Date.now();
  const results = await database.batch([
    database.prepare(`UPDATE merge_conflict_cases SET status = 'pending', resume_requested = 1, failure_reason = NULL,
      waiting_reason = NULL, revision = revision + 1, updated_at = ?
      WHERE id = ? AND session_id = ? AND revision = ? AND status IN ('pending', 'failed', 'awaiting_input') AND current_resolver_run_id IS NULL AND (mode != 'ai' OR automatic_attempts < 2)
      AND EXISTS (SELECT 1 FROM sessions s JOIN session_members sm ON sm.session_id = s.id WHERE s.id = ? AND s.ended_at IS NULL AND sm.user_id = ? AND sm.removed_at IS NULL)`)
      .bind(now, caseId, sessionId, revision, sessionId, userId),
    database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ? AND changes() = 1").bind(now, sessionId),
  ]);
  return Number(results[0]?.meta?.changes ?? 0) > 0;
}

export async function answerConflictQuestions(
  sessionId: string,
  caseId: string,
  userId: string,
  answers: Array<{ questionId: string; answer: string }>,
  database = getDb(),
): Promise<"answered" | "stale" | "missing"> {
  const role = await getActiveMembershipRole(sessionId, userId, database);
  if (!role) return "missing";
  if (role !== "owner") {
    const authored = await database.prepare(
      `SELECT 1 AS allowed FROM merge_conflict_cases mc
       JOIN agent_runs source ON source.id = mc.source_run_id
       JOIN floor_queue_prompts p ON p.queue_item_id = source.queue_item_id
       WHERE mc.id = ? AND mc.session_id = ? AND p.author_user_id = ? LIMIT 1`,
    ).bind(caseId, sessionId, userId).first<{ allowed: number }>();
    if (!authored) return "missing";
  }
  const current = await database.prepare(
    `SELECT q.id FROM merge_conflict_questions q JOIN merge_conflict_cases mc ON mc.id = q.case_id
     WHERE mc.id = ? AND mc.session_id = ? AND mc.status = 'awaiting_input' AND q.answer IS NULL
     ORDER BY q.position, q.id`,
  ).bind(caseId, sessionId).all<{ id: string }>();
  if (current.results.length === 0) {
    const exists = await database.prepare("SELECT id FROM merge_conflict_cases WHERE id = ? AND session_id = ?")
      .bind(caseId, sessionId).first<{ id: string }>();
    return exists ? "stale" : "missing";
  }
  const expected = current.results.map((item) => item.id).sort();
  const submitted = answers.map((item) => item.questionId).sort();
  if (expected.length !== submitted.length || expected.some((id, index) => id !== submitted[index])) return "stale";
  const now = Date.now();
  const statements = answers.map((answer) => database.prepare(
    `UPDATE merge_conflict_questions SET answer = ?, answered_by = ?, answered_at = ?
     WHERE id = ? AND case_id = ? AND answer IS NULL`,
  ).bind(answer.answer, userId, now, answer.questionId, caseId));
  const results = await database.batch([
    ...statements,
    database.prepare(
      `UPDATE merge_conflict_cases SET status = 'pending', resume_requested = 1, automatic_attempts = 0,
              current_resolver_run_id = NULL, failure_reason = NULL, updated_at = ?
       WHERE id = ? AND session_id = ? AND status = 'awaiting_input'
         AND NOT EXISTS (SELECT 1 FROM merge_conflict_questions WHERE case_id = ? AND answer IS NULL)`,
    ).bind(now, caseId, sessionId, caseId),
    database.prepare(
      `UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ?
       WHERE id = ? AND changes() = 1`,
    ).bind(now, sessionId),
  ]);
  const answerChanges = results.slice(0, statements.length).every((result) => Number(result?.meta?.changes ?? 0) === 1);
  const caseChanges = Number(results[statements.length]?.meta?.changes ?? 0) === 1;
  return answerChanges && caseChanges ? "answered" : "stale";
}

export async function getConflictCaseForMember(sessionId: string, caseId: string, userId: string, database = getDb()): Promise<MergeConflictCase | null> {
  if (!(await getMembershipRole(sessionId, userId, database))) return null;
  return (await getMergeConflictCases(sessionId, database)).find((item) => item.id === caseId) ?? null;
}

export async function markConflictResolved(runId: string, candidateSha: string, database = getDb()): Promise<boolean> {
  const now = Date.now();
  const result = await database.prepare(`UPDATE merge_conflict_cases SET status = 'resolved', failure_reason = NULL, waiting_reason = NULL,
      revision = revision + 1, resolved_at = ?, updated_at = ?
    WHERE current_resolver_run_id = ? AND status = 'resolving'
      AND EXISTS (SELECT 1 FROM merge_conflict_attempts a JOIN agent_runs r ON r.id = a.run_id
        JOIN repository_candidates c ON c.id = r.candidate_id WHERE a.run_id = ? AND a.case_id = merge_conflict_cases.id
        AND (r.status = 'integrated' AND r.integrated_candidate_sha = ? OR r.status = 'ready' AND r.completion = 'no_changes'
          AND a.execution_mode != 'prepare' AND c.candidate_sha = ? AND c.remote_candidate_sha = ?))`)
    .bind(now, now, runId, runId, candidateSha, candidateSha, candidateSha).run();
  return Number(result.meta?.changes ?? 0) === 1;
}
