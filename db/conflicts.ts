import type { MergeConflictCase, MergeConflictQuestion } from "@/lib/floor-types";
import type { CredentialProvider } from "@/lib/provider-credentials";
import { getDb } from "./index";
import { getActiveMembershipRole, getMembershipRole } from "./sessions";

export const MAX_AUTOMATIC_CONFLICT_ATTEMPTS = 2;

type CaseRow = Omit<MergeConflictCase, "conflictPaths" | "questions" | "prompts" | "attempts"> & { conflictPaths: string };

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
            mc.resolved_at AS resolvedAt
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
  return rows.results.map((row) => ({
    ...row,
    currentResolverRunId: row.currentResolverRunId ?? null,
    explanation: row.explanation ?? null,
    conflictPaths: paths(row.conflictPaths),
    automaticAttempts: Number(row.automaticAttempts),
    failureReason: row.failureReason ?? null,
    resolvedAt: row.resolvedAt ?? null,
    questions: byCase.get(row.id) ?? [],
    prompts: promptsByCase.get(row.id) ?? [],
    attempts: attemptsByCase.get(row.id) ?? [],
  }));
}

/** Creates one stable case for an original conflict, or advances the same
 * case when a resolver result itself conflicts after the candidate moved. */
export async function recordIntegrationConflict(runId: string, reason: string, database = getDb()): Promise<{ sessionId: string; caseId: string } | null> {
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
    const retry = Boolean(row.autoResolve) && Number(row.automaticAttempts ?? 0) < MAX_AUTOMATIC_CONFLICT_ATTEMPTS;
    await database.prepare(
      `UPDATE merge_conflict_cases SET latest_source_run_id = ?, current_resolver_run_id = NULL,
              status = ?, failure_reason = ?, updated_at = ? WHERE id = ?`,
    ).bind(runId, retry ? "pending" : "failed", retry ? null : reason.slice(0, 2_000), now, row.existingCaseId).run();
    await database.prepare("UPDATE floor_queue_items SET status = 'blocked', updated_at = ? WHERE id = (SELECT queue_item_id FROM agent_runs WHERE id = ?)")
      .bind(now, runId).run();
    return { sessionId: row.sessionId, caseId: row.existingCaseId };
  }
  const id = crypto.randomUUID();
  await database.prepare(
    `INSERT INTO merge_conflict_cases
       (id, session_id, source_run_id, latest_source_run_id, status, explanation, conflict_paths,
        automatic_attempts, resume_requested, failure_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, '[]', 0, 0, NULL, ?, ?)
     ON CONFLICT(source_run_id) DO NOTHING`,
  ).bind(id, row.sessionId, runId, runId, reason.slice(0, 4_000), now, now).run();
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
};

export async function getPendingConflict(sessionId: string, database = getDb()): Promise<PendingConflict | null> {
  const row = await database.prepare(
    `SELECT mc.id, mc.session_id AS sessionId, source.agent_id AS agentId, a.provider AS agentProvider,
            mc.status, mc.automatic_attempts AS automaticAttempts, mc.resume_requested AS resumeRequested,
            s.auto_resolve_conflicts AS autoResolve
     FROM merge_conflict_cases mc
     JOIN sessions s ON s.id = mc.session_id
     JOIN agent_runs source ON source.id = mc.latest_source_run_id
     JOIN floor_agents a ON a.id = source.agent_id
     WHERE mc.session_id = ? AND mc.status IN ('pending', 'failed') AND mc.current_resolver_run_id IS NULL
       AND (mc.resume_requested = 1 OR (s.auto_resolve_conflicts = 1 AND mc.status = 'pending' AND mc.automatic_attempts < ?))
     ORDER BY mc.updated_at, mc.id LIMIT 1`,
  ).bind(sessionId, MAX_AUTOMATIC_CONFLICT_ATTEMPTS).first<Omit<PendingConflict, "autoResolve" | "resumeRequested"> & { autoResolve: number; resumeRequested: number }>();
  return row ? { ...row, autoResolve: Boolean(row.autoResolve), resumeRequested: Boolean(row.resumeRequested), automaticAttempts: Number(row.automaticAttempts) } : null;
}

export async function createConflictResolverRun(
  caseId: string,
  launchKind: "automatic" | "manual" | "answer",
  database = getDb(),
): Promise<{ runId: string; sessionId: string; agentId: string } | null> {
  const context = await database.prepare(
    `SELECT mc.session_id AS sessionId, mc.status, mc.resume_requested AS resumeRequested,
            mc.automatic_attempts AS automaticAttempts, s.auto_resolve_conflicts AS autoResolve,
            source.queue_item_id AS queueItemId, source.agent_id AS agentId, source.model,
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
    queueItemId: string; agentId: string; model: string; connectionStatus: string;
    candidateId: string; candidateSha: string; remoteCandidateSha: string; ownerId: string;
  }>();
  if (!context || context.connectionStatus !== "ready" || context.candidateSha !== context.remoteCandidateSha) return null;
  if (launchKind === "automatic" && (!context.autoResolve || context.automaticAttempts >= MAX_AUTOMATIC_CONFLICT_ATTEMPTS)) return null;
  if (launchKind !== "automatic" && !context.resumeRequested) return null;
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
          workflow_instance_id, sandbox_id, created_by, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'provisioning', ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM merge_conflict_cases WHERE id = ? AND current_resolver_run_id IS NULL AND status IN ('pending', 'failed'))`,
      ).bind(runId, context.sessionId, context.queueItemId, context.agentId, context.candidateId, context.candidateSha,
        runBranch, attempt, context.model, runId, `run-${runId}`, context.ownerId, now, now, caseId),
      database.prepare(
        `INSERT INTO merge_conflict_attempts (id, case_id, run_id, launch_kind, created_at)
         SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM agent_runs WHERE id = ?)`,
      ).bind(crypto.randomUUID(), caseId, runId, launchKind, now, runId),
      database.prepare(
        `UPDATE merge_conflict_cases SET current_resolver_run_id = ?, status = 'resolving', resume_requested = 0,
                automatic_attempts = automatic_attempts + ?, failure_reason = NULL, updated_at = ?
         WHERE id = ? AND EXISTS (SELECT 1 FROM merge_conflict_attempts WHERE run_id = ?)`,
      ).bind(runId, launchKind === "manual" ? 0 : 1, now, caseId, runId),
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
    `SELECT mc.id AS caseId, mc.session_id AS sessionId, mc.latest_source_run_id AS sourceRunId,
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
     JOIN agent_runs source ON source.id = mc.latest_source_run_id
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
  await database.batch([
    database.prepare("DELETE FROM merge_conflict_questions WHERE case_id = ? AND answer IS NULL").bind(context.caseId),
    ...questions.map((question, position) => database.prepare(
      `INSERT INTO merge_conflict_questions
       (id, case_id, requested_by_run_id, position, question, requested_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), context.caseId, runId, position, question, now)),
    database.prepare(
      `UPDATE merge_conflict_cases SET status = 'awaiting_input', explanation = ?, current_resolver_run_id = NULL,
              failure_reason = NULL, updated_at = ? WHERE id = ? AND status = 'resolving'`,
    ).bind(explanation, now, context.caseId),
    database.prepare("UPDATE floor_queue_items SET status = 'blocked', updated_at = ? WHERE id = ?").bind(now, context.queueItemId),
    database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?").bind(now, context.sessionId),
  ]);
  const revision = await database.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?")
    .bind(context.sessionId).first<{ revision: number }>();
  return { sessionId: context.sessionId, revision: Number(revision?.revision ?? 0), caseId: context.caseId };
}

export async function isConflictInputRequested(runId: string, database = getDb()): Promise<boolean> {
  const row = await database.prepare(
    `SELECT 1 AS requested FROM merge_conflict_attempts mca JOIN merge_conflict_cases mc ON mc.id = mca.case_id
     WHERE mca.run_id = ? AND mc.status = 'awaiting_input'`,
  ).bind(runId).first<{ requested: number }>();
  return Boolean(row);
}

export async function finishResolverAwaitingInput(runId: string, database = getDb()): Promise<void> {
  const now = Date.now();
  await database.prepare(
    `UPDATE agent_runs SET status = 'failed', summary = 'Merge Resolver is waiting for session input.',
            completed_at = ?, updated_at = ? WHERE id = ? AND status IN ('provisioning', 'running', 'checking', 'cancel_requested')`,
  ).bind(now, now, runId).run();
  await database.prepare(
    `INSERT INTO agent_run_events (id, run_id, sequence, kind, detail, created_at)
     SELECT ?, ?, COALESCE(MAX(sequence), 0) + 1, 'awaiting_input', 'Merge Resolver requested session input.', ?
     FROM agent_run_events WHERE run_id = ?`,
  ).bind(crypto.randomUUID(), runId, now, runId).run();
}

export async function advanceConflictAfterFailure(
  runId: string,
  reason: string,
  database = getDb(),
  retryEligible = true,
): Promise<{ sessionId: string; retry: boolean } | null> {
  const row = await database.prepare(
    `SELECT mc.id AS caseId, mc.session_id AS sessionId, mc.automatic_attempts AS automaticAttempts,
            s.auto_resolve_conflicts AS autoResolve, source.queue_item_id AS queueItemId
     FROM merge_conflict_attempts mca JOIN merge_conflict_cases mc ON mc.id = mca.case_id
     JOIN sessions s ON s.id = mc.session_id JOIN agent_runs source ON source.id = mc.source_run_id
     WHERE mca.run_id = ? AND mc.status = 'resolving'`,
  ).bind(runId).first<{ caseId: string; sessionId: string; automaticAttempts: number; autoResolve: number; queueItemId: string }>();
  if (!row) return null;
  const retry = retryEligible && Boolean(row.autoResolve) && Number(row.automaticAttempts) < MAX_AUTOMATIC_CONFLICT_ATTEMPTS;
  const now = Date.now();
  await database.batch([
    database.prepare(
      `UPDATE merge_conflict_cases SET current_resolver_run_id = NULL, status = ?, failure_reason = ?, updated_at = ? WHERE id = ?`,
    ).bind(retry ? "pending" : "failed", reason.slice(0, 2_000), now, row.caseId),
    database.prepare("UPDATE floor_queue_items SET status = 'blocked', updated_at = ? WHERE id = ?").bind(now, row.queueItemId),
  ]);
  return { sessionId: row.sessionId, retry };
}

export async function requestConflictResolution(sessionId: string, caseId: string, userId: string, database = getDb()): Promise<boolean | null> {
  if ((await getActiveMembershipRole(sessionId, userId, database)) !== "owner") return null;
  const exists = await database.prepare("SELECT id FROM merge_conflict_cases WHERE id = ? AND session_id = ?")
    .bind(caseId, sessionId).first<{ id: string }>();
  if (!exists) return null;
  const now = Date.now();
  const results = await database.batch([
    database.prepare(
      `UPDATE merge_conflict_cases SET status = 'pending', resume_requested = 1, failure_reason = NULL, updated_at = ?
       WHERE id = ? AND session_id = ? AND status IN ('pending', 'failed') AND current_resolver_run_id IS NULL`,
    ).bind(now, caseId, sessionId),
    database.prepare(
      `UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ?
       WHERE id = ? AND EXISTS (SELECT 1 FROM merge_conflict_cases WHERE id = ? AND session_id = ? AND resume_requested = 1)`,
    ).bind(now, sessionId, caseId, sessionId),
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

export async function markConflictResolved(runId: string, candidateSha: string, database = getDb()): Promise<void> {
  const now = Date.now();
  await database.prepare(
    `UPDATE merge_conflict_cases SET status = 'resolved', current_resolver_run_id = ?, failure_reason = NULL,
            resolved_at = ?, updated_at = ?
     WHERE id = (SELECT case_id FROM merge_conflict_attempts WHERE run_id = ?)`,
  ).bind(runId, now, now, runId).run();
  await database.prepare(
    `UPDATE merge_conflict_cases SET explanation = COALESCE(explanation, ?)
     WHERE id = (SELECT case_id FROM merge_conflict_attempts WHERE run_id = ?)`,
  ).bind(`Merge Resolver integrated the resolved changes at ${candidateSha}.`, runId).run();
}
