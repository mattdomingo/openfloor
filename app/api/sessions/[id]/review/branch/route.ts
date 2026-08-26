import { getGitHubAppConfig } from "@/db";
import { getFloorSnapshot } from "@/db/floor";
import { finishCandidateCleanup, getCandidateBranchDeleteContext } from "@/db/repositories";
import { GitHubApiError } from "@/lib/github";
import { notifyFloorChanged } from "@/lib/presence-server";
import { deleteVerifiedBranches, type CleanupTarget } from "@/lib/repository-cleanup";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import type { GitHubRepositoryOption } from "@/lib/session-types";

/* Deferred candidate-branch delete: reachable from the review page after the
   session has already auto-ended on merge (review/merge/route.ts declines to
   delete the branch when the owner asks to keep it "for now"). */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const sessionId = (await params).id;
  const context = await getCandidateBranchDeleteContext(sessionId, user.id);
  if (!context) return Response.json({ error: "Session not found" }, { status: 404 });
  if (!context.mergedAt || !context.candidateSha) {
    return Response.json({ error: "The candidate branch hasn't merged yet" }, { status: 409 });
  }
  if (context.integrationRunId) {
    return Response.json({ error: "The candidate is still being updated", runId: context.integrationRunId }, { status: 409 });
  }
  if (context.branchDeletedAt) {
    const floor = await getFloorSnapshot(sessionId, user.id);
    if (!floor) return Response.json({ error: "Session not found" }, { status: 404 });
    return Response.json({ floor });
  }
  const config = getGitHubAppConfig();
  const repository: GitHubRepositoryOption = {
    id: context.repositoryId,
    nodeId: "merge-not-required",
    owner: context.repositoryOwner,
    name: context.repositoryName,
    fullName: context.repositoryFullName,
    private: context.repositoryPrivate,
    defaultBranch: context.defaultBranch,
  };
  const targets: CleanupTarget[] = [{ id: null, name: context.candidateBranch, sha: context.candidateSha, candidate: true }];
  try {
    const cleanup = await deleteVerifiedBranches(config, context.installationId, repository, targets, context.candidateId);
    const revision = await finishCandidateCleanup(sessionId, context.candidateId, [], cleanup.candidateDeleted, cleanup.complete);
    if (!cleanup.candidateDeleted) {
      return Response.json({ error: "GitHub reports the branch changed since it was merged; it was left alone" }, { status: 409 });
    }
    const floor = await getFloorSnapshot(sessionId, user.id);
    if (!floor) return Response.json({ error: "Session not found" }, { status: 404 });
    await notifyFloorChanged(sessionId, revision, ["repository", "review"]);
    return Response.json({ floor });
  } catch (error) {
    if (error instanceof GitHubApiError) {
      const status = [403, 405, 409, 422].includes(error.status) ? 409 : 502;
      return Response.json({ error: `GitHub rejected the branch delete: ${error.message}` }, { status });
    }
    return Response.json({ error: "The candidate branch could not be deleted safely" }, { status: 502 });
  }
}
