import { env } from "cloudflare:workers";
import {
  beginCandidateFileRemoval,
  createCandidateFileRemoval,
  failCandidateFileRemoval,
  finishCandidateFileRemoval,
} from "@/db/file-removals";
import { getDb, getGitHubAppConfig } from "@/db";
import { AgentRunConflictError } from "@/db/runs";
import { getInstallationRepository, updateTestRepositoryBranchIfMatches } from "./github";
import { refreshRepositoryPreview } from "./repository-preview-lifecycle";

type WorkflowBinding = {
  create(options: { id: string; params: { action: "file_removal"; removalId: string } }): Promise<unknown>;
};

export type StartCandidateFileRemovalResult =
  | { ok: true; removalId: string }
  | { ok: false; kind: "not_ready" | "conflict"; message: string };

export async function startCandidateFileRemoval(
  sessionId: string,
  userId: string,
  input: { path: string; expectedCandidateSha: string },
): Promise<StartCandidateFileRemovalResult> {
  const bindings = env as unknown as {
    AGENT_RUN_WORKFLOW?: WorkflowBinding;
    OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS?: string;
    OPENFLOOR_TEST_AGENT_RUN_DATA?: string;
  };
  try {
    const created = await createCandidateFileRemoval(sessionId, userId, input, getDb());
    if (!created) return { ok: false, kind: "not_ready", message: "Session not found" };
    try {
      if (bindings.OPENFLOOR_TEST_ALLOW_IDENTITY_HEADERS === "true" && bindings.OPENFLOOR_TEST_AGENT_RUN_DATA) {
        await runTestCandidateFileRemoval(created.removalId);
      } else {
        if (!bindings.AGENT_RUN_WORKFLOW) throw new Error("Agent run Workflow binding is unavailable");
        await bindings.AGENT_RUN_WORKFLOW.create({
          id: `file-removal-${created.removalId}`,
          params: { action: "file_removal", removalId: created.removalId },
        });
      }
    } catch (error) {
      await failCandidateFileRemoval(created.removalId, error instanceof Error ? error.message : "File removal could not start", getDb());
      throw error;
    }
    return { ok: true, removalId: created.removalId };
  } catch (error) {
    if (error instanceof AgentRunConflictError) return { ok: false, kind: "conflict", message: error.message };
    throw error;
  }
}

async function runTestCandidateFileRemoval(removalId: string): Promise<void> {
  const context = await beginCandidateFileRemoval(removalId, getDb());
  const input = new TextEncoder().encode(`${context.expectedCandidateSha}:${context.baseSha}:${context.path}:${context.previousPath ?? ""}:${removalId}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  const removalCommitSha = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
  const config = getGitHubAppConfig();
  const repository = await getInstallationRepository(config, context.installationId, context.repositoryId);
  const updated = await updateTestRepositoryBranchIfMatches(
    config,
    context.installationId,
    repository,
    context.candidateBranch,
    context.expectedCandidateSha,
    removalCommitSha,
  );
  if (!updated) throw new AgentRunConflictError("The candidate changed before file removal could be published");
  const finished = await finishCandidateFileRemoval(removalId, removalCommitSha, getDb());
  if (finished) await refreshRepositoryPreview(finished.sessionId);
}
