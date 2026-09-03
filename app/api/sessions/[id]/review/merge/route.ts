import { getGitHubAppConfig } from "@/db";
import { getFloorSnapshot } from "@/db/floor";
import {
  finishCandidateCleanup,
  getCandidateReviewMutationContext,
  markCandidateMerged,
  reconcileCandidateReview,
} from "@/db/repositories";
import { endSession, getSessionMemberIdentities } from "@/db/sessions";
import { coauthorTrailers, getPullRequestReview, GitHubApiError, squashMergePullRequest } from "@/lib/github";
import { notifyFloorChanged, notifySessionEnded } from "@/lib/presence-server";
import { deleteVerifiedBranches, type CleanupTarget } from "@/lib/repository-cleanup";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import type { GitHubRepositoryOption } from "@/lib/session-types";
import { activeOwnerErrorResponse, mutationErrorResponse } from "@/lib/floor-api";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const sessionId = (await params).id;
  const ownerError = await activeOwnerErrorResponse(sessionId, user.id);
  if (ownerError) return ownerError;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const deleteCandidateBranch = Boolean((body as { deleteCandidateBranch?: unknown } | null)?.deleteCandidateBranch);
  let context;
  try {
    context = await getCandidateReviewMutationContext(sessionId, user.id);
  } catch (error) {
    return mutationErrorResponse(error);
  }
  if (!context) return Response.json({ error: "Session not found" }, { status: 404 });
  if (context.mergeLockedAt) {
    return Response.json({ error: "Squash merge is locked for this candidate" }, { status: 409 });
  }
  if (context.integrationRunId) {
    return Response.json({ error: "The candidate is still being updated", runId: context.integrationRunId }, { status: 409 });
  }
  if (context.candidateStatus !== "active" || context.connectionStatus !== "ready" || !context.candidateSha ||
      context.remoteCandidateSha !== context.candidateSha || !context.pullRequestNumber) {
    return Response.json({ error: "The active pull request is not ready to merge" }, { status: 409 });
  }
  const repository = repositoryFrom(context);
  const config = getGitHubAppConfig();
  try {
    let review = await getPullRequestReview(config, context.installationId, repository, context.pullRequestNumber);
    await reconcileCandidateReview(sessionId, context.candidateId, review);
    if (review.headRef !== context.candidateBranch || review.headSha !== context.candidateSha || review.baseRef !== context.baseBranch) {
      return Response.json({ error: "GitHub changed the pull request head or base; merge was refused" }, { status: 409 });
    }
    let mergeCommitSha = review.mergeCommitSha;
    if (!review.merged) {
      if (review.state !== "open" || review.draft) return Response.json({ error: "Mark the pull request ready for review before merging" }, { status: 409 });
      if (review.mergeable !== true) return Response.json({ error: review.mergeable === null ? "GitHub is still calculating mergeability; try again shortly" : "GitHub reports that this pull request is not mergeable" }, { status: 409 });
      if (review.mergeableState !== "clean") return Response.json({ error: `GitHub reports that merge requirements are ${review.mergeableState ?? "not ready"}` }, { status: 409 });
      if (!review.checksPassing) return Response.json({ error: "GitHub checks are not passing" }, { status: 409 });
      // Everyone in the session becomes a co-author of the squash commit —
      // the one commit that reaches the base branch (ENG-65).
      const trailers = coauthorTrailers(await getSessionMemberIdentities(sessionId));
      mergeCommitSha = (await squashMergePullRequest(config, context.installationId, repository, context.pullRequestNumber, context.candidateSha, trailers)).sha;
      review = await getPullRequestReview(config, context.installationId, repository, context.pullRequestNumber);
      await reconcileCandidateReview(sessionId, context.candidateId, review);
    }
    if (!review.merged || !mergeCommitSha || review.mergeCommitSha !== mergeCommitSha) {
      return Response.json({ error: "GitHub did not confirm the squash merge" }, { status: 502 });
    }
    await markCandidateMerged(sessionId, context.candidateId, user.id, mergeCommitSha);
    const targets: CleanupTarget[] = [
      ...context.runs.filter((run) => !run.branchDeletedAt && run.expectedSha).map((run) => ({ id: run.id, name: run.branchName, sha: run.expectedSha, candidate: false })),
      ...(deleteCandidateBranch ? [{ id: null, name: context.candidateBranch, sha: context.candidateSha!, candidate: true }] : []),
    ];
    const cleanup = await deleteVerifiedBranches(config, context.installationId, repository, targets, context.candidateId);
    const revision = await finishCandidateCleanup(
      sessionId,
      context.candidateId,
      cleanup.deletedRunIds,
      cleanup.candidateDeleted,
      cleanup.complete,
    );
    // A session results in one candidate branch, ever — the merge is the end
    // of the session's lifecycle regardless of whether the branch was kept.
    const ended = await endSession(sessionId, user.id, "merged");
    if (ended === "missing" || ended === "forbidden") {
      return Response.json({ error: "The merge succeeded but the session could not be ended" }, { status: 500 });
    }
    if ("blocked" in ended) {
      return Response.json({ error: "The candidate is still being updated", runId: ended.runId }, { status: 409 });
    }
    await notifySessionEnded(sessionId, ended.endedAt, ended.reason);
    const floor = await getFloorSnapshot(sessionId, user.id);
    if (!floor) return Response.json({ error: "Session not found" }, { status: 404 });
    await notifyFloorChanged(sessionId, revision, ["queue", "repository", "runs", "review"]);
    return Response.json({ floor });
  } catch (error) {
    try { return mutationErrorResponse(error); } catch { /* continue with GitHub mapping */ }
    if (error instanceof GitHubApiError) {
      const status = [403, 405, 409, 422].includes(error.status) ? 409 : 502;
      return Response.json({ error: `GitHub rejected the squash merge: ${error.message}` }, { status });
    }
    return Response.json({ error: "The pull request could not be merged safely" }, { status: 502 });
  }
}

function repositoryFrom(context: NonNullable<Awaited<ReturnType<typeof getCandidateReviewMutationContext>>>): GitHubRepositoryOption {
  return {
    id: context.repositoryId,
    nodeId: "merge-not-required",
    owner: context.repositoryOwner,
    name: context.repositoryName,
    fullName: context.repositoryFullName,
    private: context.repositoryPrivate,
    defaultBranch: context.defaultBranch,
  };
}
