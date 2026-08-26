import {
  AgentRunConflictError,
  AgentRunNotReadyError,
  beginRunIntegration,
  bumpAgentRunRevision,
  createAgentRun,
  finishAgentReply,
  finishAgentRun,
  finishRunCheck,
  finishRunPublished,
  finishRunIntegrated,
  getQueueItemProvider,
  getRunExecutionContext,
  insertRunActivityEvents,
  markRunChecking,
  markRunCheckRunning,
  markRunRunning,
  markRunPublishing,
  markRunIntegrationConflicted,
  recordRunArtifact,
  replaceRunFiles,
  RUNNER_SEQUENCE_BASE,
} from "@/db/runs";
import { getDb, getGitHubAppConfig } from "@/db";
import {
  activateRepositoryCandidate,
  failRepositoryCandidate,
  getActiveRepositoryCandidateForMember,
  getRepositoryConnectionForMember,
  reserveRepositoryCandidate,
} from "@/db/repositories";
import { getMembershipRole, getOwnerHourQuota, getSessionForMember, PLAN_LIMITS } from "@/db/sessions";
import { renderRunBrief } from "@/db/session-context";
import {
  advanceConflictAfterFailure,
  createConflictResolverRun,
  finishResolverAwaitingInput,
  getConflictRunContext,
  getMergeConflictCases,
  markConflictResolved,
  recordIntegrationConflict,
  requestConflictInput,
  type PendingConflict,
} from "@/db/conflicts";
import { createDraftPullRequest, createRepositoryBranch, getInstallationRepository, getRepositoryRefSha, GitHubApiError, mergeRepositoryBranch, setTestRepositoryMergeConflict } from "@/lib/github";
import { renderConflictResolverPrompt } from "@/lib/conflict-resolver-prompt";
import { providerLabel } from "@/lib/provider-credentials";
import { disabledRunProviders } from "@/lib/provider-rollout";
import { openFloorBranchName } from "@/lib/repository-refs";
import { notifyFloorChanged, notifyRunActivity } from "@/lib/presence-server";
import { env } from "cloudflare:workers";

type WorkflowBinding = { create(options: { id: string; params: { runId: string } }): Promise<unknown> };
type R2BucketLike = { put(key: string, value: string, options?: unknown): Promise<unknown> };
type TestRunFile = {
  path: string;
  changeKind?: "add" | "update" | "delete";
  additions: number;
  deletions: number;
  summary: string;
  diff: string;
};
type TestAgentRunData = {
  holdPrompts?: string[];
  failPrompts?: string[];
  conflictFirstAttemptPrompts?: string[];
  resolverConflictFirstAttemptPrompts?: string[];
  resolverFailFirstAttemptPrompts?: string[];
  resolverFailPrompts?: string[];
  resolverQuestionPrompts?: string[];
  changedPath?: string;
  pathByPrompt?: Record<string, string>;
  diff?: string;
  filesByPrompt?: Record<string, TestRunFile[]>;
  activityEvents?: Array<{ kind: string; detail: string }>;
  activityEventsByPrompt?: Record<string, Array<{ kind: string; detail: string }>>;
  log?: string;
  stageDelayMs?: number;
  // Reply-run only (kind: "reply"): the text a test reply run answers with.
  replyByPrompt?: Record<string, string>;
  replyText?: string;
};

export type StartRunResult =
  | { ok: true; runId: string }
  | { ok: false; kind: "disabled" | "not_ready" | "conflict" | "quota_exhausted"; message: string };

// Providers whose runs cannot start right now, from the rollout gates. The
// router passes this into runRoutingTick so gated items are SKIPPED during
// auto-dispatch (a per-item condition); the seam check below still refuses a
// direct manual start with kind "disabled" (the correct answer there).
export { disabledRunProviders } from "@/lib/provider-rollout";

// This is the one seam that covers every way a run can start: the two HTTP
// routes (run, retry) AND worker/session-router.ts's auto-dispatch DO, which
// has no HTTP layer at all. A quota check placed in the route handlers
// instead would be silently bypassed whenever a session's auto_dispatch is
// on. Returning a StartRunResult variant rather than throwing matters for
// the same reason: db/routing.ts already treats any non-"conflict" failure
// as a session-wide precondition and holds with exponential backoff — a
// throw would instead hit the router DO's bare catch and retry every 60s
// forever, since "owner is out of hours" doesn't resolve until the month
// rolls over.
export async function startQueueItemRun(sessionId: string, queueItemId: string, userId: string, kind: "task" | "reply" = "task"): Promise<StartRunResult> {
  const bindings = env as unknown as {
    AGENT_RUN_WORKFLOW?: WorkflowBinding;
    AGENT_RUN_ENABLED?: string;
    PREFLIGHT_LOGS?: R2BucketLike;
    OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS?: string;
    OPENFLOOR_TEST_AGENT_RUN_DATA?: string;
  };
  if (bindings.AGENT_RUN_ENABLED !== "true" && bindings.OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS !== "true") {
    return { ok: false, kind: "disabled", message: "Agent execution is not enabled" };
  }
  // Independent rollout gate for the Claude runner (same convention as
  // AGENT_RUN_ENABLED): stays false until the image with the Agent SDK and
  // sandbox packages, the anthropic gateway, and a resolvable credential are
  // live. This seam check answers the manual-run path; auto-dispatch never
  // reaches it for gated items because runRoutingTick skips them upstream —
  // a "disabled" result here would otherwise hold the whole session's queue.
  const disabledProviders = disabledRunProviders();
  if (disabledProviders.size > 0) {
    const provider = await getQueueItemProvider(sessionId, queueItemId, getDb());
    if (provider && disabledProviders.has(provider)) {
      return { ok: false, kind: "disabled", message: `${providerLabel(provider)} execution is not enabled` };
    }
  }
  // Unlike worker/presence.ts's use of this same function, a null quota here
  // does not fail closed: this is the first thing in the function that
  // touches the session at all (no prior authorization confirmed it
  // exists), so null is the ordinary shape of "sessionId doesn't resolve to
  // anything," not just a rare invariant violation — createAgentRun below
  // already turns that into the existing AgentRunNotReadyError("Session not
  // found"), which failing closed here would only pre-empt with a bare throw.
  const quota = await getOwnerHourQuota(sessionId, getDb());
  if (quota && quota.endedAt == null && quota.seconds >= PLAN_LIMITS[quota.plan].hours * 3600) {
    return { ok: false, kind: "quota_exhausted", message: "Your plan's monthly session hours are used up." };
  }
  try {
    await ensureNextCandidateCycle(sessionId, userId);
    const run = await createAgentRun(sessionId, queueItemId, userId, kind);
    const effectiveKind = run.kind === "reply" ? "reply" : "task";
    if (bindings.OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS === "true" && bindings.OPENFLOOR_TEST_AGENT_RUN_DATA && bindings.PREFLIGHT_LOGS) {
      const result = effectiveKind === "reply"
        ? await runTestAgentReply(run.id, bindings.OPENFLOOR_TEST_AGENT_RUN_DATA, bindings.PREFLIGHT_LOGS)
        : await runTestAgent(run.id, bindings.OPENFLOOR_TEST_AGENT_RUN_DATA, bindings.PREFLIGHT_LOGS);
      if (result === "ready" && effectiveKind !== "reply") await publishTestRun(run.id, bindings.OPENFLOOR_TEST_AGENT_RUN_DATA);
    } else {
      if (!bindings.AGENT_RUN_WORKFLOW) throw new Error("Agent run Workflow binding is unavailable");
      await bindings.AGENT_RUN_WORKFLOW.create({ id: run.id, params: { runId: run.id } });
    }
    return { ok: true, runId: run.id };
  } catch (error) {
    if (error instanceof AgentRunNotReadyError) return { ok: false, kind: "not_ready", message: error.message };
    if (error instanceof AgentRunConflictError) return { ok: false, kind: "conflict", message: error.message };
    throw error;
  }
}

/** Starts a system-owned resolver attempt through the same Workflow binding
 * as ordinary runs. The case creator already pinned the source agent/model;
 * provider credentials continue to resolve from that agent owner at runtime. */
export async function startConflictResolverRun(conflict: PendingConflict): Promise<StartRunResult> {
  const bindings = env as unknown as {
    AGENT_RUN_WORKFLOW?: WorkflowBinding;
    AGENT_RUN_ENABLED?: string;
    OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS?: string;
    OPENFLOOR_TEST_AGENT_RUN_DATA?: string;
    PREFLIGHT_LOGS?: R2BucketLike;
  };
  if (bindings.AGENT_RUN_ENABLED !== "true" && bindings.OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS !== "true") {
    return { ok: false, kind: "disabled", message: "Agent execution is not enabled" };
  }
  if (disabledRunProviders().has(conflict.agentProvider)) {
    return { ok: false, kind: "disabled", message: `${providerLabel(conflict.agentProvider)} execution is not enabled` };
  }
  const quota = await getOwnerHourQuota(conflict.sessionId, getDb());
  if (quota && quota.endedAt == null && quota.seconds >= PLAN_LIMITS[quota.plan].hours * 3600) {
    return { ok: false, kind: "quota_exhausted", message: "Your plan's monthly session hours are used up." };
  }
  const launchKind = conflict.resumeRequested
    ? await hasAnsweredConflictQuestions(conflict.id) ? "answer" as const : "manual" as const
    : "automatic" as const;
  const run = await createConflictResolverRun(conflict.id, launchKind, getDb());
  if (!run) return { ok: false, kind: "conflict", message: "The conflict case is no longer available to start." };
  if (bindings.OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS === "true" && bindings.OPENFLOOR_TEST_AGENT_RUN_DATA && bindings.PREFLIGHT_LOGS) {
    const result = await runTestAgent(run.runId, bindings.OPENFLOOR_TEST_AGENT_RUN_DATA, bindings.PREFLIGHT_LOGS);
    if (result === "ready") await publishTestRun(run.runId, bindings.OPENFLOOR_TEST_AGENT_RUN_DATA);
    else if (result === "failed") await advanceConflictAfterFailure(run.runId, "A required resolver check failed.", getDb());
  } else {
    if (!bindings.AGENT_RUN_WORKFLOW) throw new Error("Agent run Workflow binding is unavailable");
    await bindings.AGENT_RUN_WORKFLOW.create({ id: run.runId, params: { runId: run.runId } });
  }
  return { ok: true, runId: run.runId };
}

async function hasAnsweredConflictQuestions(caseId: string): Promise<boolean> {
  const row = await getDb().prepare(
    "SELECT 1 AS present FROM merge_conflict_questions WHERE case_id = ? AND answer IS NOT NULL LIMIT 1",
  ).bind(caseId).first<{ present: number }>();
  return Boolean(row);
}

async function ensureNextCandidateCycle(sessionId: string, userId: string): Promise<void> {
  if ((await getMembershipRole(sessionId, userId)) !== "owner") return;
  if (await getActiveRepositoryCandidateForMember(sessionId, userId)) return;
  const connection = await getRepositoryConnectionForMember(sessionId, userId);
  if (!connection || connection.status !== "ready") return;
  const session = await getSessionForMember(sessionId, userId);
  if (!session) return;
  const candidateId = crypto.randomUUID();
  const branchName = openFloorBranchName(sessionId, "candidate", candidateId, session.title);
  const config = getGitHubAppConfig();
  const repository = await getInstallationRepository(config, connection.installationId, connection.repositoryId);
  const baseSha = await getRepositoryRefSha(config, connection.installationId, repository, connection.baseBranch);
  const reserved = await reserveRepositoryCandidate(
    sessionId, userId, connection.id, candidateId, session.title, session.objective ?? "", branchName, connection.baseBranch, baseSha,
  );
  if (!reserved) return;
  try {
    const candidateSha = await createRepositoryBranch(config, connection.installationId, repository, branchName, baseSha);
    if (candidateSha !== baseSha) throw new GitHubApiError("GitHub created the next candidate at an unexpected SHA", 502);
    await activateRepositoryCandidate(sessionId, candidateId, candidateSha);
  } catch (error) {
    await failRepositoryCandidate(candidateId);
    throw error;
  }
}

async function runTestAgent(runId: string, encoded: string, bucket: R2BucketLike): Promise<"hold" | "failed" | "ready"> {
  const data = JSON.parse(encoded) as TestAgentRunData;
  const context = await getRunExecutionContext(runId);
  if (!context) throw new Error("Test run context is missing");
  await holdTestRunStage(runId, data);
  const prompt = await renderTestRunPrompt(runId);
  if (!prompt) throw new Error("Test run session brief is missing");
  const promptKey = `runs/${runId}/prompt.txt`;
  await bucket.put(promptKey, prompt, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
  await recordRunArtifact(runId, "prompt", promptKey, "text/plain; charset=utf-8", prompt.length);
  await markRunRunning(runId, `test-${runId}`);
  await holdTestRunStage(runId, data);
  if (data.holdPrompts?.some((value) => context.prompts.some((prompt) => prompt.text.includes(value)))) return "hold";
  if (context.conflictCaseId && data.resolverQuestionPrompts?.some((value) => context.prompts.some((item) => item.text.includes(value)))) {
    const conflict = (await getMergeConflictCases(context.sessionId)).find((item) => item.id === context.conflictCaseId);
    if (conflict && !conflict.questions.some((question) => question.answer !== null)) {
      await requestConflictInput(runId, "Repository intent is ambiguous and needs a session decision.", [
        "Should the resolver preserve the existing public behavior?",
        "May the resolver remove the conflicting legacy path?",
      ]);
      await finishResolverAwaitingInput(runId);
      return "failed";
    }
  }
  const conflict = context.conflictCaseId
    ? (await getMergeConflictCases(context.sessionId)).find((item) => item.id === context.conflictCaseId)
    : null;
  const shouldFail = context.conflictCaseId
    ? (data.resolverFailPrompts?.some((value) => context.prompts.some((prompt) => prompt.text.includes(value))) ?? false)
      || (conflict?.automaticAttempts === 1
        && (data.resolverFailFirstAttemptPrompts?.some((value) => context.prompts.some((prompt) => prompt.text.includes(value))) ?? false))
    : data.failPrompts?.some((value) => context.prompts.some((prompt) => prompt.text.includes(value))) ?? false;
  const matchedPath = Object.entries(data.pathByPrompt ?? {}).find(([prompt]) => context.prompts.some((item) => item.text.includes(prompt)))?.[1];
  const path = matchedPath ?? data.changedPath ?? "src/agent-change.ts";
  const matchedFiles = Object.entries(data.filesByPrompt ?? {}).find(([prompt]) => context.prompts.some((item) => item.text.includes(prompt)))?.[1];
  const fallbackDiff = data.diff ?? `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+export const implemented = true;\n`;
  const files = matchedFiles?.length ? matchedFiles : [{ path, changeKind: "add" as const, additions: 1, deletions: 0, summary: "Agent-created test change", diff: fallbackDiff }];
  const matchedActivity = Object.entries(data.activityEventsByPrompt ?? {}).find(([prompt]) => context.prompts.some((item) => item.text.includes(prompt)))?.[1];
  const activitySource = matchedActivity ?? data.activityEvents ?? [
    { kind: "reasoning", detail: "Reviewing the requested change before editing." },
    { kind: "command", detail: "$ git status --short" },
    ...files.map((file) => ({ kind: "file_edit", detail: `edited ${file.path}` })),
    { kind: "agent_message", detail: `Implemented the requested change across ${files.length} files.` },
  ];
  const inserted = await insertRunActivityEvents(runId, activitySource.map((event, index) => ({
    sequence: RUNNER_SEQUENCE_BASE + index + 1, kind: event.kind, detail: event.detail,
  })));
  if (inserted.length > 0) await notifyRunActivity(context.sessionId, { runId, agentId: context.agentId, events: inserted });
  const codexLogKey = `runs/${runId}/codex.log`;
  const codexLog = data.log ?? "Codex test adapter completed a real deterministic run contract.\n";
  await bucket.put(codexLogKey, codexLog);
  await recordRunArtifact(runId, "codex_log", codexLogKey, "text/plain", codexLog.length);
  await markRunChecking(runId, `thread-${runId}`, `Implemented the requested change across ${files.length} files.`);
  await replaceRunFiles(runId, files.map((file) => ({
    path: file.path,
    changeKind: file.changeKind ?? "add",
    additions: file.additions,
    deletions: file.deletions,
    summary: file.summary,
    diffPreview: file.diff,
  })));
  await holdTestRunStage(runId, data);
  const diff = files.map((file) => file.diff).join("\n");
  const diffKey = `runs/${runId}/changes.diff`;
  await bucket.put(diffKey, diff);
  await recordRunArtifact(runId, "diff", diffKey, "text/x-diff", diff.length);
  for (const check of context.checks) {
    await markRunCheckRunning(runId, check.id);
    const log = shouldFail ? "required check failed\n" : "required check passed\n";
    const logKey = `runs/${runId}/checks/${check.position}.log`;
    await bucket.put(logKey, log);
    await finishRunCheck(runId, check.id, { status: shouldFail ? "failed" : "passed", exitCode: shouldFail ? 1 : 0, durationMs: 10, outputExcerpt: log, logKey });
    if (shouldFail) break;
  }
  const readySummary = context.checks.length > 0
    ? `Codex changed ${files.length} files; all required checks passed. Changes remain local to openfloor.`
    : `Codex changed ${files.length} files; no check commands were configured. Changes remain local to openfloor.`;
  await finishAgentRun(runId, shouldFail ? "failed" : "ready", shouldFail ? "A required check failed." : readySummary);
  await holdTestRunStage(runId, data);
  return shouldFail ? "failed" : "ready";
}

// Reply-run counterpart of runTestAgent: same brief-rendering and prompt
// artifact, but no files/checks/log — a reply run answers, it doesn't edit.
async function runTestAgentReply(runId: string, encoded: string, bucket: R2BucketLike): Promise<"hold" | "failed" | "ready"> {
  const data = JSON.parse(encoded) as TestAgentRunData;
  const context = await getRunExecutionContext(runId);
  if (!context) throw new Error("Test run context is missing");
  await holdTestRunStage(runId, data);
  const brief = await renderRunBrief(runId);
  if (!brief) throw new Error("Test run session brief is missing");
  const promptKey = `runs/${runId}/prompt.txt`;
  await bucket.put(promptKey, brief.text, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
  await recordRunArtifact(runId, "prompt", promptKey, "text/plain; charset=utf-8", brief.text.length);
  await markRunRunning(runId, `test-${runId}`);
  await holdTestRunStage(runId, data);
  if (data.holdPrompts?.some((value) => context.prompts.some((prompt) => prompt.text.includes(value)))) return "hold";
  const shouldFail = data.failPrompts?.some((value) => context.prompts.some((prompt) => prompt.text.includes(value))) ?? false;
  const matchedReply = Object.entries(data.replyByPrompt ?? {}).find(([prompt]) => context.prompts.some((item) => item.text.includes(prompt)))?.[1];
  const finalResponse = matchedReply ?? data.replyText ?? `Answered: ${context.prompts.map((prompt) => prompt.text).join(" | ")}`;
  const activitySource = data.activityEvents ?? [
    { kind: "reasoning", detail: "Reading the session brief and repository before answering." },
    { kind: "agent_message", detail: finalResponse },
  ];
  const inserted = await insertRunActivityEvents(runId, activitySource.map((event, index) => ({
    sequence: RUNNER_SEQUENCE_BASE + index + 1, kind: event.kind, detail: event.detail,
  })));
  if (inserted.length > 0) await notifyRunActivity(context.sessionId, { runId, agentId: context.agentId, events: inserted });
  await holdTestRunStage(runId, data);
  await finishAgentReply(runId, shouldFail ? "failed" : "ready", shouldFail ? null : finalResponse, shouldFail ? "The reply could not be generated." : "Answered the prompt.");
  await holdTestRunStage(runId, data);
  return shouldFail ? "failed" : "ready";
}

async function publishTestRun(runId: string, encoded: string) {
  const data = JSON.parse(encoded) as TestAgentRunData;
  const context = await getRunExecutionContext(runId);
  if (!context?.runBranch) throw new Error("Test run branch is missing");
  const bytes = new TextEncoder().encode(`${runId}:${context.runBranch}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
  const commitSha = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
  await markRunPublishing(runId, { bundleKey: `runs/${runId}/result.bundle`, bundleSizeBytes: bytes.length, localCommitSha: commitSha });
  await holdTestRunStage(runId, data);
  const config = getGitHubAppConfig();
  const repository = await getInstallationRepository(config, context.installationId, context.repositoryId);
  const remoteSha = await createRepositoryBranch(config, context.installationId, repository, context.runBranch, commitSha);
  await finishRunPublished(runId, commitSha, remoteSha);
  await holdTestRunStage(runId, data);
  const conflict = context.conflictCaseId
    ? (await getMergeConflictCases(context.sessionId)).find((item) => item.id === context.conflictCaseId)
    : null;
  const sourceConflict = !context.conflictCaseId && context.attempt === 1
    && data.conflictFirstAttemptPrompts?.some((value) => context.prompts.some((prompt) => prompt.text.includes(value)));
  const resolverConflict = Boolean(context.conflictCaseId && conflict?.automaticAttempts === 1
    && data.resolverConflictFirstAttemptPrompts?.some((value) => context.prompts.some((prompt) => prompt.text.includes(value))));
  if (sourceConflict || resolverConflict) {
    setTestRepositoryMergeConflict(repository.id, commitSha);
  }
  const integration = await beginRunIntegration(runId);
  await holdTestRunStage(runId, data);
  try {
    const merged = await mergeRepositoryBranch(config, integration.installationId, repository, integration.candidateBranch, commitSha, `Integrate openfloor run ${runId.slice(0, 8)}`);
    const pullRequest = integration.pullRequestNumber ? null : await createDraftPullRequest(config, integration.installationId, repository, {
      title: integration.candidateName, body: integration.candidateDescription,
      head: integration.candidateBranch, base: integration.baseBranch,
    });
    await finishRunIntegrated(runId, merged.sha, pullRequest);
    if (context.conflictCaseId) await markConflictResolved(runId, merged.sha);
    await holdTestRunStage(runId, data);
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 409) {
      await markRunIntegrationConflicted(runId, error.message);
      await recordIntegrationConflict(runId, error.message);
      return;
    }
    throw error;
  }
}

async function renderTestRunPrompt(runId: string): Promise<string | null> {
  const brief = await renderRunBrief(runId);
  if (!brief) return null;
  const context = await getRunExecutionContext(runId);
  if (!context?.conflictCaseId) return brief.text;
  const conflictContext = await getConflictRunContext(runId);
  const conflict = (await getMergeConflictCases(context.sessionId)).find((item) => item.id === context.conflictCaseId);
  if (!conflictContext || !conflict) return null;
  return renderConflictResolverPrompt({
    conflict,
    sourceSummary: conflictContext.sourceSummary,
    sourceConflictReason: conflictContext.sourceConflictReason,
    sessionBrief: brief.text,
  });
}

async function holdTestRunStage(runId: string, data: TestAgentRunData): Promise<void> {
  const delayMs = Math.max(0, Math.min(Number(data.stageDelayMs ?? 0), 5_000));
  if (delayMs === 0) return;
  const change = await bumpAgentRunRevision(runId);
  if (change) await notifyFloorChanged(change.sessionId, change.revision, ["queue", "runs"]);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
