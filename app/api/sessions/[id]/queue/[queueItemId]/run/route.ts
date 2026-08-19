import { getFloorSnapshot } from "@/db/floor";
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
  markRunChecking,
  markRunCheckRunning,
  markRunRunning,
  markRunPublishing,
  markRunIntegrationConflicted,
  recordRunArtifact,
  replaceRunFiles,
} from "@/db/runs";
import { getGitHubAppConfig } from "@/db";
import {
  activateRepositoryCandidate,
  failRepositoryCandidate,
  getActiveRepositoryCandidateForMember,
  getRepositoryConnectionForMember,
  reserveRepositoryCandidate,
} from "@/db/repositories";
import { getMembershipRole, getSessionForMember } from "@/db/sessions";
import { createDraftPullRequest, createRepositoryBranch, getInstallationRepository, getRepositoryRefSha, GitHubApiError, mergeRepositoryBranch, setTestRepositoryMergeConflict } from "@/lib/github";
import { notifyFloorChanged } from "@/lib/presence-server";
import { openFloorBranchName } from "@/lib/repository-refs";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { env } from "cloudflare:workers";

type WorkflowBinding = { create(options: { id: string; params: { runId: string } }): Promise<unknown> };
type R2BucketLike = { put(key: string, value: string, options?: unknown): Promise<unknown> };

export async function POST(_request: Request, { params }: { params: Promise<{ id: string; queueItemId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id: sessionId, queueItemId } = await params;
  const bindings = env as unknown as {
    AGENT_RUN_WORKFLOW?: WorkflowBinding;
    AGENT_RUN_ENABLED?: string;
    PREFLIGHT_LOGS?: R2BucketLike;
    OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS?: string;
    OPENFLOOR_TEST_AGENT_RUN_DATA?: string;
  };
  if (bindings.AGENT_RUN_ENABLED !== "true" && bindings.OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS !== "true") {
    return Response.json({ error: "Agent execution is not enabled" }, { status: 503 });
  }
  try {
    await ensureNextCandidateCycle(sessionId, user.id);
    const run = await createAgentRun(sessionId, queueItemId, user.id);
    if (bindings.OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS === "true" && bindings.OPENFLOOR_TEST_AGENT_RUN_DATA && bindings.PREFLIGHT_LOGS) {
      const result = await runTestAgent(run.id, bindings.OPENFLOOR_TEST_AGENT_RUN_DATA, bindings.PREFLIGHT_LOGS);
      if (result === "ready") await publishTestRun(run.id, bindings.OPENFLOOR_TEST_AGENT_RUN_DATA);
    } else {
      if (!bindings.AGENT_RUN_WORKFLOW) throw new Error("Agent run Workflow binding is unavailable");
      await bindings.AGENT_RUN_WORKFLOW.create({ id: run.id, params: { runId: run.id } });
    }
    const floor = await getFloorSnapshot(sessionId, user.id);
    if (!floor) return Response.json({ error: "Session not found" }, { status: 404 });
    await notifyFloorChanged(sessionId, floor.revision, ["queue", "runs", "review"]);
    return Response.json({ floor }, { status: 202 });
  } catch (error) {
    if (error instanceof AgentRunNotReadyError) return Response.json({ error: error.message }, { status: error.message === "Session not found" ? 404 : 409 });
    if (error instanceof AgentRunConflictError) return Response.json({ error: error.message }, { status: 409 });
    return Response.json({ error: "Agent run could not be started" }, { status: 502 });
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
  const data = JSON.parse(encoded) as { holdPrompts?: string[]; failPrompts?: string[]; changedPath?: string; pathByPrompt?: Record<string, string>; diff?: string };
  const context = await getRunExecutionContext(runId);
  if (!context) throw new Error("Test run context is missing");
  await markRunRunning(runId, `test-${runId}`);
  if (data.holdPrompts?.some((value) => context.prompts.some((prompt) => prompt.text.includes(value)))) return "hold";
  const shouldFail = data.failPrompts?.some((value) => context.prompts.some((prompt) => prompt.text.includes(value))) ?? false;
  const matchedPath = Object.entries(data.pathByPrompt ?? {}).find(([prompt]) => context.prompts.some((item) => item.text.includes(prompt)))?.[1];
  const path = matchedPath ?? data.changedPath ?? "src/agent-change.ts";
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
  await finishAgentRun(runId, shouldFail ? "failed" : "ready", shouldFail ? "A required check failed." : "Codex changed 1 file; all required checks passed. Changes remain local to OpenFloor.");
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
    const merged = await mergeRepositoryBranch(config, integration.installationId, repository, integration.candidateBranch, commitSha, `Integrate OpenFloor run ${runId.slice(0, 8)}`);
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
