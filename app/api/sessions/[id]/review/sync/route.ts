import { getGitHubAppConfig } from "@/db";
import { getFloorSnapshot } from "@/db/floor";
import {
  getCandidateReviewSyncContext,
  reconcileCandidateReview,
} from "@/db/repositories";
import { getPullRequestReview, GitHubApiError } from "@/lib/github";
import { notifyFloorChanged } from "@/lib/presence-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import type { GitHubRepositoryOption } from "@/lib/session-types";
import { mutationErrorResponse } from "@/lib/floor-api";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const sessionId = (await params).id;
  let context;
  try {
    context = await getCandidateReviewSyncContext(sessionId, user.id);
  } catch (error) {
    return mutationErrorResponse(error);
  }
  if (!context) return Response.json({ error: "Session not found" }, { status: 404 });
  if (context.candidateStatus !== "active" || context.connectionStatus !== "ready" || !context.pullRequestNumber) {
    return Response.json({ error: "No active pull request review is available to synchronize" }, { status: 409 });
  }
  const repository: GitHubRepositoryOption = {
    id: context.repositoryId,
    nodeId: "review-not-required",
    owner: context.repositoryOwner,
    name: context.repositoryName,
    fullName: context.repositoryFullName,
    private: context.repositoryPrivate,
    defaultBranch: context.defaultBranch,
  };
  try {
    const config = getGitHubAppConfig();
    const review = await getPullRequestReview(config, context.installationId, repository, context.pullRequestNumber);
    const revision = await reconcileCandidateReview(sessionId, context.candidateId, review);
    const floor = await getFloorSnapshot(sessionId, user.id);
    if (!floor) return Response.json({ error: "Session not found" }, { status: 404 });
    await notifyFloorChanged(sessionId, revision, ["repository", "review"]);
    return Response.json({ floor });
  } catch (error) {
    try { return mutationErrorResponse(error); } catch { /* continue with GitHub mapping */ }
    if (error instanceof GitHubApiError) return Response.json({ error: `GitHub synchronization failed: ${error.message}` }, { status: error.status === 404 ? 409 : 502 });
    throw error;
  }
}
