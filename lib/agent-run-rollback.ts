import { env } from "cloudflare:workers";
import { getDb, getGitHubAppConfig } from "@/db";
import {
  beginAgentRunRollback,
  createAgentRunRollback,
  failAgentRunRollback,
  finishAgentRunRollback,
} from "@/db/rollbacks";
import { AgentRunConflictError, AgentRunNotReadyError } from "@/db/runs";
import { getInstallationRepository, updateTestRepositoryBranchIfMatches } from "./github";

type WorkflowBinding = {
  create(options: { id: string; params: { runId: string; action: "rollback"; rollbackId: string } }): Promise<unknown>;
};

export type StartAgentRunRollbackResult =
  | { ok: true; rollbackId: string }
  | { ok: false; kind: "not_ready" | "conflict"; message: string };

export async function startAgentRunRollback(
  sessionId: string,
  runId: string,
  userId: string,
): Promise<StartAgentRunRollbackResult> {
  const bindings = env as unknown as {
    AGENT_RUN_WORKFLOW?: WorkflowBinding;
    OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS?: string;
    OPENFLOOR_TEST_AGENT_RUN_DATA?: string;
  };
  try {
    const created = await createAgentRunRollback(sessionId, runId, userId, getDb());
    if (!created) return { ok: false, kind: "not_ready", message: "Session not found" };
    try {
      if (bindings.OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS === "true" && bindings.OPENFLOOR_TEST_AGENT_RUN_DATA) {
        await runTestAgentRollback(created.rollbackId);
      } else {
        if (!bindings.AGENT_RUN_WORKFLOW) throw new Error("Agent run Workflow binding is unavailable");
        await bindings.AGENT_RUN_WORKFLOW.create({
          id: `rollback-${created.rollbackId}`,
          params: { runId, action: "rollback", rollbackId: created.rollbackId },
        });
      }
    } catch (error) {
      await failAgentRunRollback(created.rollbackId, error instanceof Error ? error.message : "Rollback could not start", getDb());
      throw error;
    }
    return { ok: true, rollbackId: created.rollbackId };
  } catch (error) {
    if (error instanceof AgentRunNotReadyError) return { ok: false, kind: "not_ready", message: error.message };
    if (error instanceof AgentRunConflictError) return { ok: false, kind: "conflict", message: error.message };
    throw error;
  }
}

async function runTestAgentRollback(rollbackId: string): Promise<void> {
  const context = await beginAgentRunRollback(rollbackId, getDb());
  const input = new TextEncoder().encode(`${context.expectedCandidateSha}:${context.targetCommitSha}:${rollbackId}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  const rollbackCommitSha = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
  const config = getGitHubAppConfig();
  const repository = await getInstallationRepository(config, context.installationId, context.repositoryId);
  const updated = await updateTestRepositoryBranchIfMatches(
    config,
    context.installationId,
    repository,
    context.candidateBranch,
    context.expectedCandidateSha,
    rollbackCommitSha,
  );
  if (!updated) throw new AgentRunConflictError("The candidate changed before rollback could be published");
  await finishAgentRunRollback(rollbackId, rollbackCommitSha, getDb());
}
