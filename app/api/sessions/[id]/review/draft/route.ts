import { getGitHubAppConfig } from "@/db";
import { getFloorSnapshot } from "@/db/floor";
import {
  getCandidateReviewMutationContext,
  markCandidateReviewDraft,
  reconcileCandidateReview,
} from "@/db/repositories";
import { convertPullRequestToDraft, getPullRequestReview, GitHubApiError } from "@/lib/github";
import { notifyFloorChanged } from "@/lib/presence-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import type { GitHubRepositoryOption } from "@/lib/session-types";
import { activeOwnerErrorResponse, mutationErrorResponse } from "@/lib/floor-api";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const sessionId = (await params).id;
  const ownerError = await activeOwnerErrorResponse(sessionId, user.id);
  if (ownerError) return ownerError;
  let context;
  try {
    context = await getCandidateReviewMutationContext(sessionId, user.id);
  } catch (error) {
    return mutationErrorResponse(error);
  }
  if (!context) return Response.json({ error: "Session not found" }, { status: 404 });
  if (context.candidateStatus !== "active" || context.connectionStatus !== "ready" || !context.candidateSha ||
      context.remoteCandidateSha !== context.candidateSha || !context.pullRequestNumber || !context.pullRequestNodeId) {
    return Response.json({ error: "The active pull request is not ready to change review state" }, { status: 409 });
  }
  const repository = repositoryFrom(context);
  try {
    const config = getGitHubAppConfig();
    let review = await getPullRequestReview(config, context.installationId, repository, context.pullRequestNumber);
    if (review.state !== "open" || review.merged || review.headRef !== context.candidateBranch || review.headSha !== context.candidateSha || review.baseRef !== context.baseBranch) {
      await reconcileCandidateReview(sessionId, context.candidateId, review);
      return Response.json({ error: "GitHub changed the pull request; review readiness was not changed" }, { status: 409 });
    }
    if (!review.draft) {
      await convertPullRequestToDraft(config, context.installationId, repository, context.pullRequestNodeId);
      review = await getPullRequestReview(config, context.installationId, repository, context.pullRequestNumber);
    }
    await reconcileCandidateReview(sessionId, context.candidateId, review);
    const revision = await markCandidateReviewDraft(sessionId, context.candidateId);
    const floor = await getFloorSnapshot(sessionId, user.id);
    if (!floor) return Response.json({ error: "Session not found" }, { status: 404 });
    await notifyFloorChanged(sessionId, revision, ["repository", "review"]);
    return Response.json({ floor });
  } catch (error) {
    try { return mutationErrorResponse(error); } catch { /* continue with GitHub mapping */ }
    if (error instanceof GitHubApiError) return Response.json({ error: `GitHub could not convert this pull request to a draft: ${error.message}` }, { status: error.status === 404 ? 409 : 502 });
    throw error;
  }
}

function repositoryFrom(context: NonNullable<Awaited<ReturnType<typeof getCandidateReviewMutationContext>>>): GitHubRepositoryOption {
  return {
    id: context.repositoryId,
    nodeId: "review-not-required",
    owner: context.repositoryOwner,
    name: context.repositoryName,
    fullName: context.repositoryFullName,
    private: context.repositoryPrivate,
    defaultBranch: context.defaultBranch,
  };
}
