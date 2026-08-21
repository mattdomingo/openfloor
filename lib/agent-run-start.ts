import {
  AgentRunConflictError,
  AgentRunNotReadyError,
  beginRunIntegration,
  createAgentRun,
  finishAgentRun,
  finishRunCheck,
  finishRunPublished,
  finishRunIntegrated,
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
import { createDraftPullRequest, createRepositoryBranch, getInstallationRepository, getRepositoryRefSha, GitHubApiError, mergeRepositoryBranch, setTestRepositoryMergeConflict } from "@/lib/github";
import { openFloorBranchName } from "@/lib/repository-refs";
import { notifyRunActivity } from "@/lib/presence-server";
import { env } from "cloudflare:workers";

type WorkflowBinding = { create(options: { id: string; params: { runId: string } }): Promise<unknown> };
type R2BucketLike = { put(key: string, value: string, options?: unknown): Promise<unknown> };

export type StartRunResult =
  | { ok: true; runId: string }
  | { ok: false; kind: "disabled" | "not_ready" | "conflict" | "quota_exhausted"; message: string };

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
export async function startQueueItemRun(sessionId: string, queueItemId: string, userId: string): Promise<StartRunResult> {
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
    const run = await createAgentRun(sessionId, queueItemId, userId);
    if (bindings.OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS === "true" && bindings.OPENFLOOR_TEST_AGENT_RUN_DATA && bindings.PREFLIGHT_LOGS) {
      const result = await runTestAgent(run.id, bindings.OPENFLOOR_TEST_AGENT_RUN_DATA, bindings.PREFLIGHT_LOGS);
      if (result === "ready") await publishTestRun(run.id, bindings.OPENFLOOR_TEST_AGENT_RUN_DATA);
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
  const data = JSON.parse(encoded) as { holdPrompts?: string[]; failPrompts?: string[]; changedPath?: string; pathByPrompt?: Record<string, string>; diff?: string; activityEvents?: Array<{ kind: string; detail: string }> };
  const context = await getRunExecutionContext(runId);
  if (!context) throw new Error("Test run context is missing");
  await markRunRunning(runId, `test-${runId}`);
  if (data.holdPrompts?.some((value) => context.prompts.some((prompt) => prompt.text.includes(value)))) return "hold";
  const shouldFail = data.failPrompts?.some((value) => context.prompts.some((prompt) => prompt.text.includes(value))) ?? false;
  const matchedPath = Object.entries(data.pathByPrompt ?? {}).find(([prompt]) => context.prompts.some((item) => item.text.includes(prompt)))?.[1];
  const path = matchedPath ?? data.changedPath ?? "src/agent-change.ts";
  const activitySource = data.activityEvents ?? [
    { kind: "reasoning", detail: "Reviewing the requested change before editing." },
    { kind: "command", detail: "$ git status --short" },
    { kind: "file_edit", detail: `edited ${path}` },
    { kind: "agent_message", detail: "Implemented the requested focused change." },
  ];
  const inserted = await insertRunActivityEvents(runId, activitySource.map((event, index) => ({
    sequence: RUNNER_SEQUENCE_BASE + index + 1, kind: event.kind, detail: event.detail,
  })));
  if (inserted.length > 0) await notifyRunActivity(context.sessionId, { runId, agentId: context.agentId, events: inserted });
  const diff = data.diff ?? `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+export const implemented = true;\n`;
  const codexLogKey = `runs/${runId}/codex.log`;
  await bucket.put(codexLogKey, "Codex test adapter completed a real deterministic run contract.\n");
  await recordRunArtifact(runId, "codex_log", codexLogKey, "text/plain", 63);
  await markRunChecking(runId, `thread-${runId}`, "Implemented the requested focused change.");
  await replaceRunFiles(runId, [{ path, changeKind: "add", additions: 1, deletions: 0, summary: "Agent-created test change", diffPreview: diff }]);
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
    ? "Codex changed 1 file; all required checks passed. Changes remain local to openfloor."
    : "Codex changed 1 file; no check commands were configured. Changes remain local to openfloor.";
  await finishAgentRun(runId, shouldFail ? "failed" : "ready", shouldFail ? "A required check failed." : readySummary);
  return shouldFail ? "failed" : "ready";
}

async function publishTestRun(runId: string, encoded: string) {
  const context = await getRunExecutionContext(runId);
  if (!context?.runBranch) throw new Error("Test run branch is missing");
  const bytes = new TextEncoder().encode(`${runId}:${context.runBranch}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
  const commitSha = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
  await markRunPublishing(runId, { bundleKey: `runs/${runId}/result.bundle`, bundleSizeBytes: bytes.length, localCommitSha: commitSha });
  const config = getGitHubAppConfig();
  const repository = await getInstallationRepository(config, context.installationId, context.repositoryId);
  const remoteSha = await createRepositoryBranch(config, context.installationId, repository, context.runBranch, commitSha);
  await finishRunPublished(runId, commitSha, remoteSha);
  const data = JSON.parse(encoded) as { conflictFirstAttemptPrompts?: string[] };
  if (context.attempt === 1 && data.conflictFirstAttemptPrompts?.some((value) => context.prompts.some((prompt) => prompt.text.includes(value)))) {
    setTestRepositoryMergeConflict(repository.id, commitSha);
  }
  const integration = await beginRunIntegration(runId);
  try {
    const merged = await mergeRepositoryBranch(config, integration.installationId, repository, integration.candidateBranch, commitSha, `Integrate openfloor run ${runId.slice(0, 8)}`);
    const pullRequest = integration.pullRequestNumber ? null : await createDraftPullRequest(config, integration.installationId, repository, {
      title: integration.candidateName, body: integration.candidateDescription,
      head: integration.candidateBranch, base: integration.baseBranch,
    });
    await finishRunIntegrated(runId, merged.sha, pullRequest);
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 409) {
      await markRunIntegrationConflicted(runId, error.message);
      return;
    }
    throw error;
  }
}
