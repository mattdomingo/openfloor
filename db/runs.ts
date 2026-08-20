import type { AgentRun, AgentRunCheck, AgentRunFile, AgentRunStatus } from "@/lib/floor-types";
import { getDb, type D1DatabaseLike } from "./index";
import { getActiveMembershipRole, getMembershipRole } from "./sessions";

export const AGENT_RUN_MODEL = "gpt-5.6-terra";
export class AgentRunConflictError extends Error {}
export class AgentRunNotReadyError extends Error {}
export class AgentRunIntegrationBusyError extends Error {}

type RunRecord = Omit<AgentRun, "checks" | "files">;
type CheckRecord = Omit<AgentRunCheck, "hasLog"> & { logKey: string | null };

export async function getAgentRunsForMember(sessionId: string, userId: string, database = getDb()): Promise<AgentRun[] | null> {
  if (!(await getMembershipRole(sessionId, userId, database))) return null;
  return getAgentRuns(sessionId, database);
}

export async function getAgentRuns(sessionId: string, database = getDb()): Promise<AgentRun[]> {
  const rows = await database.prepare(
    `SELECT r.id, r.queue_item_id AS queueItemId, r.agent_id AS agentId, a.name AS agentName,
            r.candidate_id AS candidateId, r.candidate_sha AS candidateSha, r.attempt, r.status,
            r.run_branch AS runBranch, r.local_commit_sha AS localCommitSha,
            r.run_commit_sha AS runCommitSha, r.remote_run_sha AS remoteRunSha,
            r.model, r.summary, r.final_response AS finalResponse, r.created_by AS createdBy,
            r.created_at AS createdAt, r.started_at AS startedAt, r.completed_at AS completedAt,
            r.published_at AS publishedAt, r.discarded_at AS discardedAt, r.branch_deleted_at AS branchDeletedAt,
            r.integration_base_sha AS integrationBaseSha, r.integrated_candidate_sha AS integratedCandidateSha,
            r.conflict_reason AS conflictReason, r.integration_started_at AS integrationStartedAt,
            r.integrated_at AS integratedAt,
            r.cancel_requested_at AS cancelRequestedAt, r.updated_at AS updatedAt
     FROM agent_runs r JOIN floor_agents a ON a.id = r.agent_id
     WHERE r.session_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT 20`,
  ).bind(sessionId).all<RunRecord>();
  return Promise.all(rows.results.map(async (run) => ({
    ...run,
    attempt: Number(run.attempt),
    checks: await getRunChecks(run.id, database),
    files: await getRunFiles(run.id, database),
  })));
}

export async function createAgentRun(sessionId: string, queueItemId: string, userId: string, database = getDb()): Promise<AgentRun> {
  if ((await getActiveMembershipRole(sessionId, userId, database)) !== "owner") throw new AgentRunNotReadyError("Session not found");
  const context = await database.prepare(
    `SELECT q.id AS queueItemId, q.status AS queueStatus, q.agent_id AS agentId,
            rc.id AS connectionId, rc.status AS connectionStatus,
            c.id AS candidateId, c.candidate_sha AS candidateSha, c.remote_candidate_sha AS remoteCandidateSha
     FROM floor_queue_items q
     LEFT JOIN repository_connections rc ON rc.session_id = q.session_id
     LEFT JOIN repository_candidates c ON c.session_id = q.session_id AND c.status = 'active' AND c.merged_at IS NULL
     WHERE q.session_id = ? AND q.id = ?`,
  ).bind(sessionId, queueItemId).first<{
    queueItemId: string; queueStatus: string; agentId: string | null; connectionId: string | null;
    connectionStatus: string | null; candidateId: string | null; candidateSha: string | null; remoteCandidateSha: string | null;
  }>();
  if (!context) throw new AgentRunNotReadyError("Queue item not found");
  if (!context.agentId) throw new AgentRunNotReadyError("Assign this queue item to an agent before running it");
  if (context.queueStatus !== "queued") throw new AgentRunConflictError("This queue item is not ready to run");
  if (!context.connectionId || context.connectionStatus !== "ready" || !context.candidateId || !context.candidateSha || context.remoteCandidateSha !== context.candidateSha) {
    throw new AgentRunNotReadyError("Synchronize a ready, unmodified candidate before starting an agent run");
  }
  const commands = await database.prepare(
    "SELECT position, command FROM repository_check_commands WHERE connection_id = ? ORDER BY position",
  ).bind(context.connectionId).all<{ position: number; command: string }>();
  if (commands.results.length === 0) throw new AgentRunNotReadyError("Configure at least one required check command before starting an agent run");
  const previous = await database.prepare("SELECT COALESCE(MAX(attempt), 0) AS attempt FROM agent_runs WHERE queue_item_id = ?")
    .bind(queueItemId).first<{ attempt: number }>();
  const attempt = Number(previous?.attempt ?? 0) + 1;
  const id = crypto.randomUUID();
  const runBranch = `openfloor/${sessionId.slice(0, 8)}/run/${id.slice(0, 8)}`;
  const now = Date.now();
  try {
    await database.batch([
      database.prepare(
        `INSERT INTO agent_runs
         (id, session_id, queue_item_id, agent_id, candidate_id, candidate_sha, run_branch, attempt, status, model,
          workflow_instance_id, sandbox_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'provisioning', ?, ?, ?, ?, ?, ?)`,
      ).bind(id, sessionId, queueItemId, context.agentId, context.candidateId, context.candidateSha, runBranch, attempt,
        AGENT_RUN_MODEL, id, `run-${id}`, userId, now, now),
      ...commands.results.map((check) => database.prepare(
        `INSERT INTO agent_run_checks (id, run_id, position, command, status, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      ).bind(crypto.randomUUID(), id, Number(check.position), check.command, now)),
      database.prepare("UPDATE floor_queue_items SET status = 'running', updated_at = ? WHERE id = ? AND session_id = ? AND status = 'queued'")
        .bind(now, queueItemId, sessionId),
      database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?").bind(now, sessionId),
    ]);
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) throw new AgentRunConflictError("This queue item already has an active run");
    throw error;
  }
  await appendRunEvent(id, "queued", `Run attempt ${attempt} created.`, database);
  return (await getAgentRun(id, database))!;
}

export async function getAgentRun(runId: string, database = getDb()): Promise<AgentRun | null> {
  const row = await database.prepare(
    `SELECT r.id, r.queue_item_id AS queueItemId, r.agent_id AS agentId, a.name AS agentName,
            r.candidate_id AS candidateId, r.candidate_sha AS candidateSha, r.attempt, r.status,
            r.run_branch AS runBranch, r.local_commit_sha AS localCommitSha,
            r.run_commit_sha AS runCommitSha, r.remote_run_sha AS remoteRunSha,
            r.model, r.summary, r.final_response AS finalResponse, r.created_by AS createdBy,
            r.created_at AS createdAt, r.started_at AS startedAt, r.completed_at AS completedAt,
            r.published_at AS publishedAt, r.discarded_at AS discardedAt, r.branch_deleted_at AS branchDeletedAt,
            r.integration_base_sha AS integrationBaseSha, r.integrated_candidate_sha AS integratedCandidateSha,
            r.conflict_reason AS conflictReason, r.integration_started_at AS integrationStartedAt,
            r.integrated_at AS integratedAt,
            r.cancel_requested_at AS cancelRequestedAt, r.updated_at AS updatedAt
     FROM agent_runs r JOIN floor_agents a ON a.id = r.agent_id WHERE r.id = ?`,
  ).bind(runId).first<RunRecord>();
  if (!row) return null;
  return { ...row, attempt: Number(row.attempt), checks: await getRunChecks(runId, database), files: await getRunFiles(runId, database) };
}

export async function getRunExecutionContext(runId: string, database = getDb()) {
  const run = await database.prepare(
    `SELECT r.id, r.session_id AS sessionId, r.queue_item_id AS queueItemId, r.agent_id AS agentId,
            r.candidate_sha AS candidateSha, r.attempt, r.status, r.sandbox_id AS sandboxId,
            r.run_branch AS runBranch, r.bundle_key AS bundleKey, r.bundle_size_bytes AS bundleSizeBytes,
            r.local_commit_sha AS localCommitSha,
            r.sandbox_process_id AS sandboxProcessId, r.model,
            r.created_at AS createdAt,
            s.title AS sessionTitle, s.objective, a.name AS agentName, a.role AS agentRole, a.task AS agentTask,
            rc.installation_id AS installationId, rc.repository_id AS repositoryId,
            rc.repository_owner AS repositoryOwner, rc.repository_name AS repositoryName,
            rc.repository_full_name AS repositoryFullName,
            c.branch_name AS candidateBranch
     FROM agent_runs r
     JOIN sessions s ON s.id = r.session_id
     JOIN floor_agents a ON a.id = r.agent_id
     JOIN repository_candidates c ON c.id = r.candidate_id
     JOIN repository_connections rc ON rc.id = c.connection_id
     WHERE r.id = ?`,
  ).bind(runId).first<{
    id: string; sessionId: string; queueItemId: string; agentId: string; candidateSha: string; attempt: number; status: AgentRunStatus;
    runBranch: string; bundleKey: string | null; bundleSizeBytes: number | null; localCommitSha: string | null; createdAt: number;
    sandboxId: string; sandboxProcessId: string | null; model: string; sessionTitle: string; objective: string | null;
    agentName: string; agentRole: string; agentTask: string; installationId: string; repositoryId: string;
    repositoryOwner: string; repositoryName: string; repositoryFullName: string; candidateBranch: string;
  }>();
  if (!run) return null;
  const prompts = await database.prepare(
    `SELECT p.text, u.display_name AS authorName FROM floor_queue_prompts p
     JOIN users u ON u.id = p.author_user_id WHERE p.queue_item_id = ? ORDER BY p.created_at, p.id`,
  ).bind(run.queueItemId).all<{ text: string; authorName: string }>();
  const checks = await database.prepare("SELECT id, position, command FROM agent_run_checks WHERE run_id = ? ORDER BY position")
    .bind(runId).all<{ id: string; position: number; command: string }>();
  return {
    ...run,
    prompts: prompts.results,
    checks: checks.results.map((check) => ({ ...check, position: Number(check.position) })),
    files: await getRunFiles(runId, database),
  };
}

export async function markRunRunning(runId: string, processId: string | null, database = getDb()): Promise<void> {
  const now = Date.now();
  await database.prepare(
    `UPDATE agent_runs SET status = 'running', sandbox_process_id = COALESCE(?, sandbox_process_id),
            started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND status IN ('provisioning', 'running')`,
  ).bind(processId, now, now, runId).run();
  await appendRunEvent(runId, "running", "Codex started in the isolated workspace.", database);
}

export async function setRunProcessId(runId: string, processId: string, database = getDb()): Promise<void> {
  await database.prepare("UPDATE agent_runs SET sandbox_process_id = ?, updated_at = ? WHERE id = ?")
    .bind(processId, Date.now(), runId).run();
}

export async function markRunChecking(runId: string, threadId: string | null, finalResponse: string | null, database = getDb()): Promise<void> {
  const now = Date.now();
  await database.prepare(
    `UPDATE agent_runs SET status = 'checking', codex_thread_id = ?, final_response = ?, updated_at = ?
     WHERE id = ? AND status IN ('running', 'checking')`,
  ).bind(threadId, finalResponse?.slice(0, 20_000) ?? null, now, runId).run();
  await appendRunEvent(runId, "checking", "Codex finished; required checks are running.", database);
}

export async function markRunCheckRunning(runId: string, checkId: string, database = getDb()): Promise<void> {
  const now = Date.now();
  await database.prepare("UPDATE agent_run_checks SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND run_id = ?")
    .bind(now, now, checkId, runId).run();
}

export async function finishRunCheck(runId: string, checkId: string, result: {
  status: "passed" | "failed" | "timed_out"; exitCode: number | null; durationMs: number; outputExcerpt: string; logKey: string;
}, database = getDb()): Promise<void> {
  const now = Date.now();
  await database.prepare(
    `UPDATE agent_run_checks SET status = ?, exit_code = ?, duration_ms = ?, output_excerpt = ?, log_key = ?,
            completed_at = ?, updated_at = ? WHERE id = ? AND run_id = ?`,
  ).bind(result.status, result.exitCode, result.durationMs, result.outputExcerpt.slice(-2_000), result.logKey, now, now, checkId, runId).run();
}

export async function replaceRunFiles(runId: string, files: Array<Omit<AgentRunFile, "id">>, database = getDb()): Promise<void> {
  const now = Date.now();
  await database.batch([
    database.prepare("DELETE FROM agent_run_files WHERE run_id = ?").bind(runId),
    ...files.map((file) => database.prepare(
      `INSERT INTO agent_run_files (id, run_id, path, change_kind, additions, deletions, summary, diff_preview, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), runId, file.path, file.changeKind, file.additions, file.deletions,
      file.summary?.slice(0, 500) ?? null, file.diffPreview.slice(0, 20_000), now)),
  ]);
}

export async function recordRunArtifact(runId: string, kind: "codex_log" | "diff", r2Key: string, contentType: string, sizeBytes: number, database = getDb()): Promise<void> {
  await database.prepare(
    `INSERT INTO agent_run_artifacts (id, run_id, kind, r2_key, content_type, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, kind) DO UPDATE SET r2_key = excluded.r2_key, content_type = excluded.content_type,
       size_bytes = excluded.size_bytes, created_at = excluded.created_at`,
  ).bind(crypto.randomUUID(), runId, kind, r2Key, contentType, sizeBytes, Date.now()).run();
}

export async function markRunPublishing(
  runId: string,
  input: { bundleKey: string; bundleSizeBytes: number; localCommitSha: string },
  database = getDb(),
): Promise<void> {
  const now = Date.now();
  const result = await database.prepare(
    `UPDATE agent_runs SET status = 'publishing', bundle_key = ?, bundle_size_bytes = ?, local_commit_sha = ?, updated_at = ?
     WHERE id = ? AND status IN ('ready', 'publishing')`,
  ).bind(input.bundleKey, input.bundleSizeBytes, input.localCommitSha, now, runId).run();
  if (result.meta?.changes) await appendRunEvent(runId, "publishing", "Validated local changes are being published to the server-generated run branch.", database);
}

export async function finishRunPublished(runId: string, commitSha: string, remoteSha: string, database = getDb()): Promise<{ sessionId: string; revision: number } | null> {
  if (commitSha !== remoteSha) throw new AgentRunConflictError("GitHub did not reconcile the published commit");
  const run = await database.prepare("SELECT session_id AS sessionId, status, run_commit_sha AS runCommitSha FROM agent_runs WHERE id = ?")
    .bind(runId).first<{ sessionId: string; status: AgentRunStatus; runCommitSha: string | null }>();
  if (!run) return null;
  if (run.status === "published" && run.runCommitSha === commitSha) {
    const current = await database.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?").bind(run.sessionId).first<{ revision: number }>();
    return { sessionId: run.sessionId, revision: Number(current?.revision ?? 0) };
  }
  if (run.status !== "publishing") throw new AgentRunConflictError("This run is not ready to publish");
  const now = Date.now();
  await database.batch([
    database.prepare(
      `UPDATE agent_runs SET status = 'published', run_commit_sha = ?, remote_run_sha = ?, published_at = ?, completed_at = ?,
              summary = 'Changes published to the verified run branch.', updated_at = ? WHERE id = ? AND status = 'publishing'`,
    ).bind(commitSha, remoteSha, now, now, now, runId),
    database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?").bind(now, run.sessionId),
  ]);
  await appendRunEvent(runId, "published", `Published and reconciled commit ${commitSha}.`, database);
  const revision = await database.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?").bind(run.sessionId).first<{ revision: number }>();
  return { sessionId: run.sessionId, revision: Number(revision?.revision ?? 0) };
}

export async function beginRunIntegration(runId: string, database = getDb()) {
  const run = await database.prepare(
    `SELECT r.id, r.session_id AS sessionId, r.queue_item_id AS queueItemId, r.status,
            r.run_branch AS runBranch, r.run_commit_sha AS runCommitSha, r.remote_run_sha AS remoteRunSha,
            c.id AS candidateId, c.name AS candidateName, c.description AS candidateDescription,
            c.branch_name AS candidateBranch, c.candidate_sha AS candidateSha,
            c.remote_candidate_sha AS remoteCandidateSha, c.base_branch AS baseBranch,
            c.integration_run_id AS integrationRunId, c.pull_request_number AS pullRequestNumber,
            rc.status AS connectionStatus,
            rc.installation_id AS installationId, rc.repository_id AS repositoryId,
            rc.repository_owner AS repositoryOwner, rc.repository_name AS repositoryName,
            rc.repository_full_name AS repositoryFullName
     FROM agent_runs r JOIN repository_candidates c ON c.id = r.candidate_id AND c.status = 'active' AND c.merged_at IS NULL
     JOIN repository_connections rc ON rc.id = c.connection_id
     WHERE r.id = ? AND r.discarded_at IS NULL`,
  ).bind(runId).first<{
    id: string; sessionId: string; queueItemId: string; status: AgentRunStatus; runBranch: string; runCommitSha: string;
    remoteRunSha: string; candidateId: string; candidateName: string; candidateDescription: string;
    candidateBranch: string; candidateSha: string; remoteCandidateSha: string;
    baseBranch: string; integrationRunId: string | null; pullRequestNumber: number | null; installationId: string;
    connectionStatus: string;
    repositoryId: string; repositoryOwner: string; repositoryName: string; repositoryFullName: string;
  }>();
  if (!run || !["published", "integrating"].includes(run.status) || !run.runCommitSha || run.runCommitSha !== run.remoteRunSha) {
    throw new AgentRunConflictError("The published run is not ready for integration");
  }
  if (run.connectionStatus !== "ready") throw new AgentRunConflictError("The repository must be synchronized before integration");
  const now = Date.now();
  const claim = await database.prepare(
    `UPDATE repository_candidates SET integration_run_id = ?, updated_at = ?
     WHERE id = ? AND (integration_run_id IS NULL OR integration_run_id = ?)`,
  ).bind(runId, now, run.candidateId, runId).run();
  if (!claim.meta?.changes && run.integrationRunId !== runId) throw new AgentRunIntegrationBusyError("Another run is integrating into this candidate");
  await database.prepare(
    `UPDATE agent_runs SET status = 'integrating', integration_base_sha = ?, integration_started_at = COALESCE(integration_started_at, ?),
            summary = 'Published changes are being integrated into the candidate branch.', updated_at = ?
     WHERE id = ? AND status IN ('published', 'integrating')`,
  ).bind(run.candidateSha, now, now, runId).run();
  await appendRunEvent(runId, "integrating", `Integrating against candidate ${run.candidateSha}.`, database);
  return run;
}

export async function finishRunIntegrated(
  runId: string,
  candidateSha: string,
  pullRequest: { number: number; nodeId: string; url: string; state: "open" | "closed"; draft: boolean } | null,
  database = getDb(),
): Promise<{ sessionId: string; revision: number } | null> {
  const run = await database.prepare("SELECT session_id AS sessionId, queue_item_id AS queueItemId, candidate_id AS candidateId FROM agent_runs WHERE id = ? AND status = 'integrating'")
    .bind(runId).first<{ sessionId: string; queueItemId: string; candidateId: string }>();
  if (!run) return null;
  const now = Date.now();
  await database.batch([
    database.prepare(
      `UPDATE repository_candidates SET candidate_sha = ?, remote_candidate_sha = ?, integration_run_id = NULL,
              pull_request_number = COALESCE(pull_request_number, ?), pull_request_node_id = COALESCE(pull_request_node_id, ?),
              pull_request_url = COALESCE(pull_request_url, ?), pull_request_state = COALESCE(pull_request_state, ?),
              pull_request_draft = COALESCE(pull_request_draft, ?), last_synced_at = ?, updated_at = ?
       WHERE id = ? AND integration_run_id = ?`,
    ).bind(candidateSha, candidateSha, pullRequest?.number ?? null, pullRequest?.nodeId ?? null, pullRequest?.url ?? null,
      pullRequest?.state ?? null, pullRequest ? (pullRequest.draft ? 1 : 0) : null, now, now, run.candidateId, runId),
    database.prepare(
      `UPDATE agent_runs SET status = 'integrated', integrated_candidate_sha = ?, integrated_at = ?, completed_at = ?,
              summary = 'Changes integrated into the active candidate branch.', updated_at = ? WHERE id = ? AND status = 'integrating'`,
    ).bind(candidateSha, now, now, now, runId),
    database.prepare(
      `UPDATE repository_connections SET status = 'ready', updated_at = ?
       WHERE id = (SELECT connection_id FROM repository_candidates WHERE id = ?) AND status != 'disconnected'`,
    ).bind(now, run.candidateId),
    database.prepare("UPDATE floor_queue_items SET status = 'completed', updated_at = ? WHERE id = ?").bind(now, run.queueItemId),
    database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?").bind(now, run.sessionId),
  ]);
  await appendRunEvent(runId, "integrated", `Candidate advanced to ${candidateSha}.`, database);
  const revision = await database.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?").bind(run.sessionId).first<{ revision: number }>();
  return { sessionId: run.sessionId, revision: Number(revision?.revision ?? 0) };
}

export async function markRunIntegrationConflicted(runId: string, reason: string, database = getDb()) {
  const run = await database.prepare("SELECT session_id AS sessionId, queue_item_id AS queueItemId, candidate_id AS candidateId FROM agent_runs WHERE id = ? AND status = 'integrating'")
    .bind(runId).first<{ sessionId: string; queueItemId: string; candidateId: string }>();
  if (!run) return null;
  const now = Date.now();
  await database.batch([
    database.prepare("UPDATE repository_candidates SET integration_run_id = NULL, updated_at = ? WHERE id = ? AND integration_run_id = ?").bind(now, run.candidateId, runId),
    database.prepare("UPDATE agent_runs SET status = 'conflicted', conflict_reason = ?, summary = ?, updated_at = ? WHERE id = ?")
      .bind(reason.slice(0, 1_000), "The run conflicts with the latest candidate branch.", now, runId),
    database.prepare("UPDATE floor_queue_items SET status = 'blocked', updated_at = ? WHERE id = ?").bind(now, run.queueItemId),
    database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?").bind(now, run.sessionId),
  ]);
  await appendRunEvent(runId, "conflicted", reason, database);
  const revision = await database.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?").bind(run.sessionId).first<{ revision: number }>();
  return { sessionId: run.sessionId, revision: Number(revision?.revision ?? 0) };
}

export async function releaseRunIntegration(runId: string, reason: string, database = getDb()) {
  const run = await database.prepare("SELECT session_id AS sessionId, candidate_id AS candidateId FROM agent_runs WHERE id = ? AND status = 'integrating'")
    .bind(runId).first<{ sessionId: string; candidateId: string }>();
  if (!run) return null;
  const now = Date.now();
  await database.batch([
    database.prepare("UPDATE repository_candidates SET integration_run_id = NULL, updated_at = ? WHERE id = ? AND integration_run_id = ?").bind(now, run.candidateId, runId),
    database.prepare("UPDATE agent_runs SET status = 'published', summary = ?, updated_at = ? WHERE id = ? AND status = 'integrating'")
      .bind(reason.slice(0, 1_000), now, runId),
    database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?").bind(now, run.sessionId),
  ]);
  await appendRunEvent(runId, "integration_failed", reason, database);
  const revision = await database.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?").bind(run.sessionId).first<{ revision: number }>();
  return { sessionId: run.sessionId, revision: Number(revision?.revision ?? 0) };
}

export async function prepareConflictedRunRetry(sessionId: string, runId: string, userId: string, database = getDb()): Promise<string | null> {
  if ((await getActiveMembershipRole(sessionId, userId, database)) !== "owner") return null;
  const run = await database.prepare("SELECT queue_item_id AS queueItemId FROM agent_runs WHERE id = ? AND session_id = ? AND status = 'conflicted'")
    .bind(runId, sessionId).first<{ queueItemId: string }>();
  if (!run) return null;
  await database.prepare("UPDATE floor_queue_items SET status = 'queued', updated_at = ? WHERE id = ? AND status = 'blocked'").bind(Date.now(), run.queueItemId).run();
  return run.queueItemId;
}

export async function recordRunPublicationFailure(runId: string, summary: string, database = getDb()): Promise<{ sessionId: string; revision: number } | null> {
  const run = await database.prepare("SELECT session_id AS sessionId, queue_item_id AS queueItemId, status FROM agent_runs WHERE id = ?")
    .bind(runId).first<{ sessionId: string; queueItemId: string; status: AgentRunStatus }>();
  if (!run || !["ready", "publishing"].includes(run.status)) return null;
  const now = Date.now();
  const nextStatus = run.status === "ready" ? "failed" : "publishing";
  const statements = [
    database.prepare("UPDATE agent_runs SET status = ?, summary = ?, updated_at = ? WHERE id = ? AND status = ?")
      .bind(nextStatus, summary.slice(0, 1_000), now, runId, run.status),
    database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?").bind(now, run.sessionId),
  ];
  if (run.status === "ready") statements.push(database.prepare("UPDATE floor_queue_items SET status = 'failed', updated_at = ? WHERE id = ?").bind(now, run.queueItemId));
  await database.batch(statements);
  await appendRunEvent(runId, "publication_failed", summary, database);
  const revision = await database.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?").bind(run.sessionId).first<{ revision: number }>();
  return { sessionId: run.sessionId, revision: Number(revision?.revision ?? 0) };
}

export async function getRunDiscardContext(sessionId: string, runId: string, userId: string, database = getDb()) {
  if ((await getActiveMembershipRole(sessionId, userId, database)) !== "owner") return null;
  return database.prepare(
    `SELECT r.id, r.run_branch AS runBranch, r.run_commit_sha AS runCommitSha, r.remote_run_sha AS remoteRunSha,
            r.discarded_at AS discardedAt, rc.installation_id AS installationId, rc.repository_id AS repositoryId,
            rc.repository_owner AS repositoryOwner, rc.repository_name AS repositoryName,
            rc.repository_full_name AS repositoryFullName, rc.repository_private AS repositoryPrivate,
            rc.default_branch AS defaultBranch
     FROM agent_runs r JOIN repository_candidates c ON c.id = r.candidate_id
     JOIN repository_connections rc ON rc.id = c.connection_id
     WHERE r.id = ? AND r.session_id = ? AND r.status = 'published'`,
  ).bind(runId, sessionId).first<{
    id: string; runBranch: string; runCommitSha: string; remoteRunSha: string; discardedAt: number | null;
    installationId: string; repositoryId: string; repositoryOwner: string; repositoryName: string;
    repositoryFullName: string; repositoryPrivate: boolean; defaultBranch: string;
  }>();
}

export async function markRunDiscarded(sessionId: string, runId: string, userId: string, database = getDb()): Promise<number | null> {
  if ((await getActiveMembershipRole(sessionId, userId, database)) !== "owner") return null;
  const now = Date.now();
  const result = await database.prepare(
    `UPDATE agent_runs SET discarded_at = ?, discarded_by = ?, updated_at = ?
     WHERE id = ? AND session_id = ? AND status = 'published' AND discarded_at IS NULL`,
  ).bind(now, userId, now, runId, sessionId).run();
  if (!result.meta?.changes) return null;
  await database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?").bind(now, sessionId).run();
  await appendRunEvent(runId, "discarded", "The verified OpenFloor-owned run branch was deleted from GitHub.", database);
  const revision = await database.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?").bind(sessionId).first<{ revision: number }>();
  return Number(revision?.revision ?? 0);
}

export async function finishAgentRun(runId: string, status: "ready" | "failed" | "cancelled", summary: string, database = getDb()): Promise<{ sessionId: string; revision: number } | null> {
  const run = await database.prepare("SELECT session_id AS sessionId, queue_item_id AS queueItemId, status FROM agent_runs WHERE id = ?")
    .bind(runId).first<{ sessionId: string; queueItemId: string; status: AgentRunStatus }>();
  if (!run) return null;
  if (["ready", "failed", "cancelled", "published", "integrated", "conflicted"].includes(run.status)) {
    const current = await database.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?").bind(run.sessionId).first<{ revision: number }>();
    return { sessionId: run.sessionId, revision: Number(current?.revision ?? 0) };
  }
  const now = Date.now();
  await database.batch([
    database.prepare(
      `UPDATE agent_runs SET status = ?, summary = ?, completed_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('provisioning', 'running', 'checking', 'cancel_requested')`,
    ).bind(status, summary.slice(0, 1_000), now, now, runId),
    // failed/cancelled runs park their queue item in a matching terminal status so
    // auto-dispatch (which only ever dispatches status = 'queued' items) never retries
    // them on its own; the user must explicitly re-run, edit, or delete the prompt.
    database.prepare("UPDATE floor_queue_items SET status = ?, updated_at = ? WHERE id = ?")
      .bind(status === "ready" ? "blocked" : status, now, run.queueItemId),
    database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?").bind(now, run.sessionId),
  ]);
  await appendRunEvent(runId, status, summary, database);
  const revision = await database.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?").bind(run.sessionId).first<{ revision: number }>();
  return { sessionId: run.sessionId, revision: Number(revision?.revision ?? 0) };
}

export async function requestAgentRunCancellation(sessionId: string, runId: string, userId: string, database = getDb()): Promise<boolean | null> {
  if ((await getMembershipRole(sessionId, userId, database)) !== "owner") return null;
  const now = Date.now();
  const result = await database.prepare(
    `UPDATE agent_runs SET status = 'cancel_requested', cancel_requested_at = ?, updated_at = ?
     WHERE id = ? AND session_id = ? AND status IN ('provisioning', 'running', 'checking')`,
  ).bind(now, now, runId, sessionId).run();
  if (!result.meta?.changes) return false;
  await database.batch([
    database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?").bind(now, sessionId),
    database.prepare(
      `INSERT INTO agent_run_events (id, run_id, sequence, kind, detail, created_at)
       SELECT ?, ?, COALESCE(MAX(sequence), 0) + 1, 'cancel_requested', 'Cancellation requested by the session owner.', ?
       FROM agent_run_events WHERE run_id = ?`,
    ).bind(crypto.randomUUID(), runId, now, runId),
  ]);
  return true;
}

export async function isRunCancellationRequested(runId: string, database = getDb()): Promise<boolean> {
  const row = await database.prepare("SELECT status FROM agent_runs WHERE id = ?").bind(runId).first<{ status: AgentRunStatus }>();
  return row?.status === "cancel_requested";
}

export async function bumpAgentRunRevision(runId: string, database = getDb()): Promise<{ sessionId: string; revision: number } | null> {
  const row = await database.prepare("SELECT session_id AS sessionId FROM agent_runs WHERE id = ?").bind(runId).first<{ sessionId: string }>();
  if (!row) return null;
  const now = Date.now();
  await database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?").bind(now, row.sessionId).run();
  const revision = await database.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?").bind(row.sessionId).first<{ revision: number }>();
  return { sessionId: row.sessionId, revision: Number(revision?.revision ?? 0) };
}

export async function getRunArtifactKeysForMember(sessionId: string, runId: string, userId: string, database = getDb()) {
  if (!(await getMembershipRole(sessionId, userId, database))) return null;
  const rows = await database.prepare(
    `SELECT a.kind, a.r2_key AS r2Key, a.content_type AS contentType
     FROM agent_run_artifacts a JOIN agent_runs r ON r.id = a.run_id WHERE r.id = ? AND r.session_id = ? ORDER BY a.kind`,
  ).bind(runId, sessionId).all<{ kind: string; r2Key: string; contentType: string }>();
  return rows.results;
}

async function appendRunEvent(runId: string, kind: string, detail: string, database: D1DatabaseLike): Promise<void> {
  await database.prepare(
    `INSERT INTO agent_run_events (id, run_id, sequence, kind, detail, created_at)
     SELECT ?, ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ? FROM agent_run_events WHERE run_id = ?`,
  ).bind(crypto.randomUUID(), runId, kind, detail.slice(0, 2_000), Date.now(), runId).run();
}

async function getRunChecks(runId: string, database: D1DatabaseLike): Promise<AgentRunCheck[]> {
  const rows = await database.prepare(
    `SELECT id, position, command, status, exit_code AS exitCode, duration_ms AS durationMs,
            output_excerpt AS outputExcerpt, log_key AS logKey, started_at AS startedAt, completed_at AS completedAt
     FROM agent_run_checks WHERE run_id = ? ORDER BY position`,
  ).bind(runId).all<CheckRecord>();
  return rows.results.map(({ logKey, ...check }) => ({ ...check, position: Number(check.position), hasLog: Boolean(logKey) }));
}

async function getRunFiles(runId: string, database: D1DatabaseLike): Promise<AgentRunFile[]> {
  const rows = await database.prepare(
    `SELECT id, path, change_kind AS changeKind, additions, deletions, summary, diff_preview AS diffPreview
     FROM agent_run_files WHERE run_id = ? ORDER BY path`,
  ).bind(runId).all<AgentRunFile>();
  return rows.results.map((file) => ({ ...file, additions: Number(file.additions), deletions: Number(file.deletions) }));
}
