import type { AgentRun, AgentRunCheck, AgentRunFile, AgentRunStatus, RunActivityEvent } from "@/lib/floor-types";
import { resolveRunModel, type CredentialProvider } from "@/lib/provider-credentials";
import { pickResumeSource, type ResumeCandidateRow } from "@/lib/run-resume";
import { normalizeRunUsage } from "@/lib/run-usage";
import { getDb, type D1DatabaseLike } from "./index";
import { getActiveMembershipRole, getMembershipRole } from "./sessions";
export class AgentRunConflictError extends Error {}
export class AgentRunNotReadyError extends Error {}
export class AgentRunIntegrationBusyError extends Error {}

type RunRecord = Omit<AgentRun, "checks" | "files">;
type CheckRecord = Omit<AgentRunCheck, "hasLog"> & { logKey: string | null };
type ScopedCheckRecord = CheckRecord & { runId: string };
type ScopedFileRecord = AgentRunFile & { runId: string };

const AGENT_RUN_SELECT = `SELECT r.id, r.queue_item_id AS queueItemId, r.agent_id AS agentId, a.name AS agentName,
        r.candidate_id AS candidateId, r.candidate_sha AS candidateSha, r.attempt, r.status, r.kind,
        r.run_branch AS runBranch, r.local_commit_sha AS localCommitSha,
        r.run_commit_sha AS runCommitSha, r.remote_run_sha AS remoteRunSha,
        r.model, r.summary, r.final_response AS finalResponse,
        r.input_tokens AS inputTokens, r.output_tokens AS outputTokens,
        r.cache_read_tokens AS cacheReadTokens, r.cache_write_tokens AS cacheWriteTokens,
        r.resumed_from_run_id AS resumedFromRunId, prior.attempt AS resumedFromAttempt,
        r.provider_thread_resumed AS providerThreadResumed,
        r.created_by AS createdBy,
        r.created_at AS createdAt, r.started_at AS startedAt, r.completed_at AS completedAt,
        r.published_at AS publishedAt, r.discarded_at AS discardedAt, r.branch_deleted_at AS branchDeletedAt,
        r.integration_base_sha AS integrationBaseSha, r.integrated_candidate_sha AS integratedCandidateSha,
        r.conflict_reason AS conflictReason, r.integration_started_at AS integrationStartedAt,
        r.integrated_at AS integratedAt,
        r.cancel_requested_at AS cancelRequestedAt, r.updated_at AS updatedAt,
        CASE WHEN mca.run_id IS NULL THEN 'task' ELSE 'conflict_resolution' END AS purpose,
        COALESCE(mca.case_id, source_case.id) AS conflictCaseId,
        rb.id AS rollbackId, rb.status AS rollbackStatus,
        rb.expected_candidate_sha AS rollbackExpectedCandidateSha,
        rb.rollback_commit_sha AS rollbackCommitSha,
        rb.failure_reason AS rollbackFailureReason, rb.created_by AS rollbackBy,
        rb.created_at AS rollbackRequestedAt, rb.completed_at AS rollbackCompletedAt
 FROM agent_runs r JOIN floor_agents a ON a.id = r.agent_id
 LEFT JOIN agent_runs prior ON prior.id = r.resumed_from_run_id
 LEFT JOIN merge_conflict_attempts mca ON mca.run_id = r.id
 LEFT JOIN merge_conflict_cases source_case ON source_case.source_run_id = r.id
 LEFT JOIN agent_run_rollbacks rb ON rb.id = (
   SELECT latest.id FROM agent_run_rollbacks latest
   WHERE latest.run_id = r.id ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1
 )`;

type RunListScope = { column: "session_id" | "candidate_id"; value: string; limit: number | null };

export async function getAgentRunsForMember(sessionId: string, userId: string, database = getDb()): Promise<AgentRun[] | null> {
  if (!(await getMembershipRole(sessionId, userId, database))) return null;
  return getAgentRuns(sessionId, database);
}

export async function getAgentRuns(sessionId: string, database = getDb()): Promise<AgentRun[]> {
  return getAgentRunsByScope({ column: "session_id", value: sessionId, limit: 20 }, database);
}

// Review attribution must cover the whole candidate, not the latest 20
// session runs used by agent cards/activity.
export async function getAgentRunsForCandidate(candidateId: string, database = getDb()): Promise<AgentRun[]> {
  return getAgentRunsByScope({ column: "candidate_id", value: candidateId, limit: null }, database);
}

async function getAgentRunsByScope(scope: RunListScope, database: D1DatabaseLike): Promise<AgentRun[]> {
  const limit = scope.limit === null ? "" : ` LIMIT ${scope.limit}`;
  const rows = await database.prepare(
    `${AGENT_RUN_SELECT} WHERE r.${scope.column} = ? ORDER BY r.created_at DESC, r.id DESC${limit}`,
  ).bind(scope.value).all<RunRecord>();
  if (rows.results.length === 0) return [];

  // Hydrate every selected run in two set-based reads. The previous per-run
  // fan-out made a 20-run floor snapshot issue 40 additional D1 queries, and
  // candidate-wide Review issued three reads for every historical run.
  const selectedRuns = `SELECT id FROM agent_runs WHERE ${scope.column} = ?${
    scope.limit === null ? "" : ` ORDER BY created_at DESC, id DESC LIMIT ${scope.limit}`
  }`;
  const [checks, files] = await Promise.all([
    database.prepare(
      `SELECT checks.run_id AS runId, checks.id, checks.position, checks.command, checks.status,
              checks.exit_code AS exitCode, checks.duration_ms AS durationMs,
              checks.output_excerpt AS outputExcerpt, checks.log_key AS logKey,
              checks.started_at AS startedAt, checks.completed_at AS completedAt
       FROM agent_run_checks checks
       JOIN (${selectedRuns}) selected ON selected.id = checks.run_id
       ORDER BY checks.run_id, checks.position`,
    ).bind(scope.value).all<ScopedCheckRecord>(),
    database.prepare(
      `SELECT files.run_id AS runId, files.id, files.path, files.change_kind AS changeKind,
              files.additions, files.deletions, files.summary, files.diff_preview AS diffPreview
       FROM agent_run_files files
       JOIN (${selectedRuns}) selected ON selected.id = files.run_id
       ORDER BY files.run_id, files.path`,
    ).bind(scope.value).all<ScopedFileRecord>(),
  ]);

  const checksByRun = new Map<string, AgentRunCheck[]>();
  for (const { runId, logKey, ...check } of checks.results) {
    const values = checksByRun.get(runId) ?? [];
    values.push({ ...check, position: Number(check.position), hasLog: Boolean(logKey) });
    checksByRun.set(runId, values);
  }
  const filesByRun = new Map<string, AgentRunFile[]>();
  for (const { runId, ...file } of files.results) {
    const values = filesByRun.get(runId) ?? [];
    values.push({ ...file, additions: Number(file.additions), deletions: Number(file.deletions) });
    filesByRun.set(runId, values);
  }
  return rows.results.map((run) => ({
    ...run,
    attempt: Number(run.attempt),
    checks: checksByRun.get(run.id) ?? [],
    files: filesByRun.get(run.id) ?? [],
  }));
}

// The provider a run for this queue item would use, for the rollout gate in
// lib/agent-run-start.ts. Null when the item or its agent doesn't resolve —
// createAgentRun produces the precise error for those shapes.
export async function getQueueItemProvider(sessionId: string, queueItemId: string, database = getDb()): Promise<CredentialProvider | null> {
  const row = await database.prepare(
    `SELECT a.provider AS provider FROM floor_queue_items q JOIN floor_agents a ON a.id = q.agent_id
     WHERE q.session_id = ? AND q.id = ?`,
  ).bind(sessionId, queueItemId).first<{ provider: CredentialProvider }>();
  return row?.provider ?? null;
}

// Feeds db/provider-credentials.ts's checkProviderBudget: who pays for this
// queue item's agent, which vendor, and which credential kind it names
// (null = the owner's default — same convention as floor_agents.credential_kind
// everywhere else).
export async function getQueueItemAgentBudgetContext(
  sessionId: string,
  queueItemId: string,
  database = getDb(),
): Promise<{ ownerUserId: string; provider: CredentialProvider; credentialKind: "api_key" | "oauth" | null } | null> {
  const row = await database.prepare(
    `SELECT a.owner_user_id AS ownerUserId, a.provider AS provider, a.credential_kind AS credentialKind
     FROM floor_queue_items q JOIN floor_agents a ON a.id = q.agent_id
     WHERE q.session_id = ? AND q.id = ?`,
  ).bind(sessionId, queueItemId).first<{ ownerUserId: string; provider: CredentialProvider; credentialKind: "api_key" | "oauth" | null }>();
  return row ?? null;
}

export async function createAgentRun(sessionId: string, queueItemId: string, userId: string, kind: "task" | "reply" = "task", database = getDb()): Promise<AgentRun> {
  if ((await getActiveMembershipRole(sessionId, userId, database)) !== "owner") throw new AgentRunNotReadyError("Session not found");
  const context = await database.prepare(
    `SELECT q.id AS queueItemId, q.status AS queueStatus, q.agent_id AS agentId, q.source_run_id AS sourceRunId,
            a.provider AS agentProvider, a.model AS agentModel, a.kind AS agentKind,
            a.deprovisioned_at AS agentDeprovisionedAt,
            rc.id AS connectionId, rc.status AS connectionStatus,
            c.id AS candidateId, c.candidate_sha AS candidateSha, c.remote_candidate_sha AS remoteCandidateSha
     FROM floor_queue_items q
     LEFT JOIN floor_agents a ON a.id = q.agent_id
     LEFT JOIN repository_connections rc ON rc.session_id = q.session_id
     LEFT JOIN repository_candidates c ON c.session_id = q.session_id AND c.status = 'active' AND c.merged_at IS NULL
     WHERE q.session_id = ? AND q.id = ?`,
  ).bind(sessionId, queueItemId).first<{
    queueItemId: string; queueStatus: string; agentId: string | null; sourceRunId: string | null; agentProvider: CredentialProvider | null;
    agentModel: string | null; agentKind: "answer" | "worker" | null; agentDeprovisionedAt: number | null; connectionId: string | null;
    connectionStatus: string | null; candidateId: string | null; candidateSha: string | null; remoteCandidateSha: string | null;
  }>();
  if (!context) throw new AgentRunNotReadyError("Queue item not found");
  if (!context.agentId) throw new AgentRunNotReadyError("Assign this queue item to an agent before running it");
  if (context.queueStatus !== "queued") throw new AgentRunConflictError("This queue item is not ready to run");
  if (!context.connectionId || context.connectionStatus !== "ready" || !context.candidateId || !context.candidateSha || context.remoteCandidateSha !== context.candidateSha) {
    throw new AgentRunNotReadyError("Synchronize a ready, unmodified candidate before starting an agent run");
  }
  const effectiveKind: "task" | "reply" = context.agentKind === "answer" ? "reply" : kind;
  if (context.agentDeprovisionedAt !== null && context.agentKind) {
    await database.prepare(
      "UPDATE floor_agents SET deprovisioned_at = NULL, idle_since = NULL, updated_at = ? WHERE id = ? AND session_id = ? AND kind IN ('answer', 'worker')",
    ).bind(Date.now(), context.agentId, sessionId).run();
  }
  const previous = await database.prepare("SELECT COALESCE(MAX(attempt), 0) AS attempt FROM agent_runs WHERE queue_item_id = ?")
    .bind(queueItemId).first<{ attempt: number }>();
  const attempt = Number(previous?.attempt ?? 0) + 1;
  const model = resolveRunModel(context.agentProvider ?? "openai", context.agentModel);
  // Thread resume: the newest eligible earlier run by this agent on this
  // candidate (same item or the item's explicit source run) whose provider
  // session store was persisted. Decided here, at the one seam every start
  // path shares, and stored on the row so the workflow needs no new params.
  const resumeRows = await database.prepare(
    `SELECT r.id, r.queue_item_id AS queueItemId, r.attempt, r.model, r.kind, r.codex_thread_id AS providerThreadId,
            s.r2_key AS sessionStoreKey, r.completed_at AS completedAt, r.created_at AS createdAt
     FROM agent_runs r LEFT JOIN agent_run_artifacts s ON s.run_id = r.id AND s.kind = 'session_store'
     WHERE r.session_id = ? AND r.agent_id = ? AND r.candidate_id = ?
     ORDER BY r.created_at DESC, r.id DESC LIMIT 10`,
  ).bind(sessionId, context.agentId, context.candidateId).all<ResumeCandidateRow>();
  const resumeSource = pickResumeSource(
    resumeRows.results.map((row) => ({ ...row, attempt: Number(row.attempt) })),
    { queueItemId, model, kind: effectiveKind === "reply" ? "reply" : null, sourceRunId: context.sourceRunId, now: Date.now() },
  );
  const id = crypto.randomUUID();
  // A reply run never publishes, so it never earns a real branch — reserving
  // the placeholder name here would leave the UI pointing at a branch that
  // doesn't exist in git.
  const runBranch = effectiveKind === "reply" ? null : `openfloor/${sessionId.slice(0, 8)}/run/${id.slice(0, 8)}`;
  const now = Date.now();
  try {
    await database.batch([
      database.prepare(
        `INSERT INTO agent_runs
         (id, session_id, queue_item_id, agent_id, candidate_id, candidate_sha, run_branch, attempt, status, model, kind,
          resumed_from_run_id, workflow_instance_id, sandbox_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'provisioning', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, sessionId, queueItemId, context.agentId, context.candidateId, context.candidateSha, runBranch, attempt,
        model, effectiveKind === "reply" ? "reply" : null, resumeSource?.id ?? null, id, `run-${id}`, userId, now, now),
      database.prepare("UPDATE floor_queue_items SET status = 'running', updated_at = ? WHERE id = ? AND session_id = ? AND status = 'queued'")
        .bind(now, queueItemId, sessionId),
      database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?").bind(now, sessionId),
    ]);
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) throw new AgentRunConflictError("This queue item already has an active run");
    throw error;
  }
  await appendRunEvent(id, "queued", `Run attempt ${attempt} created${resumeSource ? `, resuming attempt ${resumeSource.attempt}'s thread` : ""}.`, database);
  return (await getAgentRun(id, database))!;
}

export async function getAgentRun(runId: string, database = getDb()): Promise<AgentRun | null> {
  const row = await database.prepare(
    `${AGENT_RUN_SELECT} WHERE r.id = ?`,
  ).bind(runId).first<RunRecord>();
  if (!row) return null;
  return { ...row, attempt: Number(row.attempt), checks: await getRunChecks(runId, database), files: await getRunFiles(runId, database) };
}

export async function getRunExecutionContext(runId: string, database = getDb()) {
  const run = await database.prepare(
    `SELECT r.id, r.session_id AS sessionId, r.queue_item_id AS queueItemId, r.agent_id AS agentId,
            r.candidate_sha AS candidateSha, r.attempt, r.status, r.kind, r.sandbox_id AS sandboxId,
            r.run_branch AS runBranch, r.bundle_key AS bundleKey, r.bundle_size_bytes AS bundleSizeBytes,
            r.local_commit_sha AS localCommitSha,
            r.sandbox_process_id AS sandboxProcessId, r.model,
            r.created_at AS createdAt,
            s.title AS sessionTitle, s.objective, a.name AS agentName, a.role AS agentRole, a.task AS agentTask,
            a.provider AS provider,
            rc.installation_id AS installationId, rc.repository_id AS repositoryId,
            rc.repository_owner AS repositoryOwner, rc.repository_name AS repositoryName,
            rc.repository_full_name AS repositoryFullName,
            c.branch_name AS candidateBranch,
            mca.case_id AS conflictCaseId,
            prior.codex_thread_id AS resumeThreadId, prior.attempt AS resumedFromAttempt, prior.status AS resumedFromStatus,
            store.r2_key AS resumeSessionStoreKey
     FROM agent_runs r
     JOIN sessions s ON s.id = r.session_id
     JOIN floor_agents a ON a.id = r.agent_id
     JOIN repository_candidates c ON c.id = r.candidate_id
     JOIN repository_connections rc ON rc.id = c.connection_id
     LEFT JOIN merge_conflict_attempts mca ON mca.run_id = r.id
     LEFT JOIN agent_runs prior ON prior.id = r.resumed_from_run_id
     LEFT JOIN agent_run_artifacts store ON store.run_id = prior.id AND store.kind = 'session_store'
     WHERE r.id = ?`,
  ).bind(runId).first<{
    id: string; sessionId: string; queueItemId: string; agentId: string; candidateSha: string; attempt: number; status: AgentRunStatus;
    kind: "reply" | null;
    runBranch: string | null; bundleKey: string | null; bundleSizeBytes: number | null; localCommitSha: string | null; createdAt: number;
    sandboxId: string; sandboxProcessId: string | null; model: string; sessionTitle: string; objective: string | null;
    agentName: string; agentRole: string; agentTask: string; provider: CredentialProvider; installationId: string; repositoryId: string;
    repositoryOwner: string; repositoryName: string; repositoryFullName: string; candidateBranch: string;
    conflictCaseId: string | null;
    resumeThreadId: string | null; resumedFromAttempt: number | null; resumedFromStatus: AgentRunStatus | null; resumeSessionStoreKey: string | null;
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
    resumedFromAttempt: run.resumedFromAttempt === null ? null : Number(run.resumedFromAttempt),
    prompts: prompts.results,
    checks: checks.results.map((check) => ({ ...check, position: Number(check.position) })),
    files: await getRunFiles(runId, database),
  };
}

// Slim variant for the runtime gateway routes, which sit on the critical path
// of every Codex model turn and activity flush: one SELECT, no prompt, check,
// or file loading. Use getRunExecutionContext when those collections matter.
export async function getRunGatewayContext(runId: string, database = getDb()) {
  return await database.prepare(
    `SELECT r.id, r.session_id AS sessionId, r.agent_id AS agentId,
            r.candidate_sha AS candidateSha, r.status, r.bundle_key AS bundleKey,
            mca.case_id AS conflictCaseId,
            rc.installation_id AS installationId, rc.repository_id AS repositoryId,
            rc.repository_owner AS repositoryOwner, rc.repository_name AS repositoryName,
            rc.repository_full_name AS repositoryFullName
     FROM agent_runs r
     JOIN repository_candidates c ON c.id = r.candidate_id
     JOIN repository_connections rc ON rc.id = c.connection_id
     LEFT JOIN merge_conflict_attempts mca ON mca.run_id = r.id
     WHERE r.id = ?`,
  ).bind(runId).first<{
    id: string; sessionId: string; agentId: string; candidateSha: string; status: AgentRunStatus; bundleKey: string | null;
    conflictCaseId: string | null;
    installationId: string; repositoryId: string; repositoryOwner: string; repositoryName: string; repositoryFullName: string;
  }>();
}

export async function markRunRunning(runId: string, processId: string | null, database = getDb()): Promise<void> {
  const now = Date.now();
  await database.prepare(
    `UPDATE agent_runs SET status = 'running', sandbox_process_id = COALESCE(?, sandbox_process_id),
            started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND status IN ('provisioning', 'running')`,
  ).bind(processId, now, now, runId).run();
  await appendRunEvent(runId, "running", "The agent started in the isolated workspace.", database);
}

// The row is created with a placeholder sandbox id; the workflow assigns the
// real (pool-claimed) sandbox here before provisioning starts.
export async function setRunSandboxId(runId: string, sandboxId: string, database = getDb()): Promise<void> {
  await database.prepare("UPDATE agent_runs SET sandbox_id = ?, updated_at = ? WHERE id = ?")
    .bind(sandboxId, Date.now(), runId).run();
}

export async function setRunProcessId(runId: string, processId: string, database = getDb()): Promise<void> {
  await database.prepare("UPDATE agent_runs SET sandbox_process_id = ?, updated_at = ? WHERE id = ?")
    .bind(processId, Date.now(), runId).run();
}

// Called once per run, right after result.json is parsed (before the
// ok/exitCode failure check) — a run that went on to fail still spent real
// tokens against the owner's monthly budget, and recording only successes
// would let a crashlooping agent bypass its own limit. Idempotent-in-intent
// but not idempotent-in-fact: the workflow calls this exactly once per run
// (a step retry would double-count the rollup), same non-guarantee as
// recordRunArtifact just above this call site in the workflow.
export async function recordRunUsage(
  runId: string,
  provider: CredentialProvider,
  model: string,
  raw: {
    usage: unknown;
    modelUsage: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number }> | null;
    totalCostUsd: number | null;
  },
  database = getDb(),
): Promise<void> {
  const normalized = normalizeRunUsage(provider, model, raw);
  const now = Date.now();
  await database.prepare(
    `UPDATE agent_runs SET input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?,
            cost_micro_usd = ?, cost_source = ?, updated_at = ?
     WHERE id = ?`,
  ).bind(
    normalized.inputTokens, normalized.outputTokens, normalized.cacheReadTokens, normalized.cacheWriteTokens,
    normalized.costMicroUsd, normalized.costSource, now, runId,
  ).run();
  // No priced usage (an unpriced model, or a run that made no model call at
  // all) means no rollup row either — a null cost must not silently write a
  // zero that would look like a genuinely free run.
  if (normalized.costMicroUsd === null) return;
  // billed_kind is written by the gateway (db/provider-credentials.ts's
  // resolveRunProviderSecret result) the moment the run's first model call
  // resolves a credential — it is expected to already be set by the time the
  // run completes. Its absence here means no gateway call ever succeeded,
  // which normalizeRunUsage should already have reflected as a null cost
  // above; this is a defensive second check, not the primary guard.
  const owner = await database.prepare(
    `SELECT a.owner_user_id AS ownerUserId, r.billed_kind AS billedKind
     FROM agent_runs r JOIN floor_agents a ON a.id = r.agent_id WHERE r.id = ?`,
  ).bind(runId).first<{ ownerUserId: string; billedKind: "api_key" | "oauth" | "server" | null }>();
  if (!owner?.billedKind) return;
  const month = new Date(now).toISOString().slice(0, 7);
  await database.prepare(
    `INSERT INTO provider_spend_months (user_id, provider, kind, month, micro_usd, input_tokens, output_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, provider, kind, month) DO UPDATE SET
       micro_usd = micro_usd + excluded.micro_usd,
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens`,
  ).bind(
    owner.ownerUserId, provider, owner.billedKind, month,
    normalized.costMicroUsd, normalized.inputTokens ?? 0, normalized.outputTokens ?? 0,
  ).run();
}

// Records the provider thread id for every outcome (markRunChecking and
// finishAgentReply only see successes), plus whether a requested resume
// actually happened: null = no resume attempted, 1 = resumed, 0 = the runner
// fell back to a fresh thread. COALESCE keeps an id an earlier call stored
// when result.json could not be read (a killed runner that never flushed).
export async function setRunProviderThreadId(runId: string, threadId: string | null, resumed: boolean | null, database = getDb()): Promise<void> {
  await database.prepare(
    "UPDATE agent_runs SET codex_thread_id = COALESCE(?, codex_thread_id), provider_thread_resumed = ?, updated_at = ? WHERE id = ?",
  ).bind(threadId, resumed === null ? null : resumed ? 1 : 0, Date.now(), runId).run();
}

export async function markRunChecking(runId: string, threadId: string | null, finalResponse: string | null, database = getDb()): Promise<void> {
  const now = Date.now();
  await database.prepare(
    `UPDATE agent_runs SET status = 'checking', codex_thread_id = ?, final_response = ?, updated_at = ?
     WHERE id = ? AND status IN ('running', 'checking')`,
  ).bind(threadId, finalResponse?.slice(0, 20_000) ?? null, now, runId).run();
  await appendRunEvent(runId, "checking", "Codex finished; preparing to publish.", database);
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

export async function recordRunArtifact(runId: string, kind: "codex_log" | "diff" | "prompt" | "conflict_snapshot" | "session_store", r2Key: string, contentType: string, sizeBytes: number, database = getDb()): Promise<void> {
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

/* Honors a cancellation requested mid-integration (requestAgentRunCancellation
   flips status to 'cancel_requested' without touching the candidate's
   integration_run_id claim — the workflow calls this between retry attempts
   to actually release the claim and land the run in a terminal state). */
export async function cancelRunIntegration(runId: string, database = getDb()) {
  const run = await database.prepare("SELECT session_id AS sessionId, queue_item_id AS queueItemId, candidate_id AS candidateId FROM agent_runs WHERE id = ? AND status = 'cancel_requested'")
    .bind(runId).first<{ sessionId: string; queueItemId: string; candidateId: string }>();
  if (!run) return null;
  const now = Date.now();
  await database.batch([
    database.prepare("UPDATE repository_candidates SET integration_run_id = NULL, updated_at = ? WHERE id = ? AND integration_run_id = ?").bind(now, run.candidateId, runId),
    database.prepare("UPDATE agent_runs SET status = 'cancelled', summary = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'cancel_requested'")
      .bind("Integration cancelled by the session owner.", now, now, runId),
    database.prepare("UPDATE floor_queue_items SET status = 'cancelled', updated_at = ? WHERE id = ?").bind(now, run.queueItemId),
    database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ?").bind(now, run.sessionId),
  ]);
  await appendRunEvent(runId, "cancelled", "Integration cancelled by the session owner.", database);
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
  const results = await database.batch([
    database.prepare("UPDATE agent_runs SET status = 'failed', summary = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status IN ('ready', 'publishing')")
      .bind(summary.slice(0, 1_000), now, now, runId),
    database.prepare("UPDATE floor_queue_items SET status = 'failed', updated_at = ? WHERE id = ? AND changes() = 1")
      .bind(now, run.queueItemId),
    database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1, updated_at = ? WHERE id = ? AND changes() = 1")
      .bind(now, run.sessionId),
  ]);
  // Another workflow attempt may have published the run after our read. Do
  // not corrupt its queue item or advertise a revision for a transition this
  // attempt lost.
  if (Number(results[0]?.meta?.changes ?? 0) === 0) return null;
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
  await appendRunEvent(runId, "discarded", "The verified openfloor-owned run branch was deleted from GitHub.", database);
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

// finishAgentRun's counterpart for a reply run (agent_runs.kind = 'reply').
// Deliberately not the same function: finishAgentRun parks a successful
// "ready" run's queue item as 'blocked' because that status still needs to
// publish and integrate before it's truly done. A reply has no such next
// step — a delivered answer completes its queue item outright, the same way
// finishRunIntegrated completes a published task run.
export async function finishAgentReply(
  runId: string,
  status: "ready" | "failed" | "cancelled",
  finalResponse: string | null,
  summary: string,
  // A reply run never passes through markRunChecking (it has no checks to
  // run, and the "checking" status would misleadingly surface in the UI as
  // a task-pipeline stage for what is really just an answered question) —
  // so this is the only place its provider thread id gets recorded.
  threadId: string | null = null,
  database = getDb(),
): Promise<{ sessionId: string; revision: number } | null> {
  const run = await database.prepare("SELECT session_id AS sessionId, queue_item_id AS queueItemId, status FROM agent_runs WHERE id = ?")
    .bind(runId).first<{ sessionId: string; queueItemId: string; status: AgentRunStatus }>();
  if (!run) return null;
  if (["ready", "failed", "cancelled"].includes(run.status)) {
    const current = await database.prepare("SELECT floor_revision AS revision FROM sessions WHERE id = ?").bind(run.sessionId).first<{ revision: number }>();
    return { sessionId: run.sessionId, revision: Number(current?.revision ?? 0) };
  }
  const now = Date.now();
  await database.batch([
    database.prepare(
      `UPDATE agent_runs SET status = ?, codex_thread_id = ?, final_response = ?, summary = ?, completed_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('provisioning', 'running', 'cancel_requested')`,
    ).bind(status, threadId, finalResponse?.slice(0, 20_000) ?? null, summary.slice(0, 1_000), now, now, runId),
    database.prepare("UPDATE floor_queue_items SET status = ?, updated_at = ? WHERE id = ?")
      .bind(status === "ready" ? "completed" : status, now, run.queueItemId),
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
     WHERE id = ? AND session_id = ? AND status IN ('provisioning', 'running', 'checking', 'integrating')`,
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
     FROM agent_run_artifacts a JOIN agent_runs r ON r.id = a.run_id
     WHERE r.id = ? AND r.session_id = ? AND a.kind != 'session_store' ORDER BY a.kind`,
  ).bind(runId, sessionId).all<{ kind: string; r2Key: string; contentType: string }>();
  return rows.results;
}

// Runner-emitted activity events own the sequence space at and above this base;
// workflow-stage events keep the MAX+1 scheme below it until runner events exist,
// after which MAX+1 lands above the base and the merged timeline stays chronological.
export const RUNNER_SEQUENCE_BASE = 1_000_000;
export const MAX_RUNNER_EVENTS_PER_RUN = 2_000;

export async function insertRunActivityEvents(
  runId: string,
  events: Array<{ sequence: number; kind: string; detail: string }>,
  database = getDb(),
): Promise<RunActivityEvent[]> {
  if (events.length === 0) return [];
  const now = Date.now();
  const prepared: RunActivityEvent[] = events.map((event) => ({
    id: crypto.randomUUID(),
    runId,
    sequence: event.sequence,
    kind: event.kind,
    detail: event.detail.slice(0, 2_000),
    createdAt: now,
  }));
  const results = await database.batch(prepared.map((event) => database.prepare(
    "INSERT OR IGNORE INTO agent_run_events (id, run_id, sequence, kind, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(event.id, event.runId, event.sequence, event.kind, event.detail, event.createdAt)));
  return prepared.filter((_, index) => Boolean(results[index]?.meta?.changes));
}

export async function getRunEventsForMember(
  sessionId: string,
  runId: string,
  userId: string,
  after: number,
  database = getDb(),
): Promise<RunActivityEvent[] | null> {
  if (!(await getMembershipRole(sessionId, userId, database))) return null;
  const rows = await database.prepare(
    `SELECT e.id, e.run_id AS runId, e.sequence, e.kind, e.detail, e.created_at AS createdAt
     FROM agent_run_events e JOIN agent_runs r ON r.id = e.run_id
     WHERE r.id = ? AND r.session_id = ? AND e.sequence > ? ORDER BY e.sequence LIMIT 500`,
  ).bind(runId, sessionId, after).all<RunActivityEvent>();
  return rows.results.map((event) => ({ ...event, sequence: Number(event.sequence), createdAt: Number(event.createdAt) }));
}

export async function countRunnerActivityEvents(runId: string, database = getDb()): Promise<number> {
  const row = await database.prepare("SELECT COUNT(*) AS count FROM agent_run_events WHERE run_id = ? AND sequence >= ?")
    .bind(runId, RUNNER_SEQUENCE_BASE).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

export async function appendRunEvent(runId: string, kind: string, detail: string, database: D1DatabaseLike): Promise<void> {
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
