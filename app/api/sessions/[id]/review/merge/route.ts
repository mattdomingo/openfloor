import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { env } from "cloudflare:workers";
import { getGitHubAppConfig } from "@/db";
import { getFloorSnapshot } from "@/db/floor";
import {
  finishCandidateCleanup,
  getCandidateReviewMutationContext,
  markCandidateMerged,
  reconcileCandidateReview,
} from "@/db/repositories";
import {
  createInstallationToken,
  deleteTestRepositoryBranchIfMatches,
  getPullRequestReview,
  getRepositoryRefSha,
  GitHubApiError,
  squashMergePullRequest,
} from "@/lib/github";
import { notifyFloorChanged } from "@/lib/presence-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import type { GitHubRepositoryOption } from "@/lib/session-types";

type CleanupTarget = { id: string | null; name: string; sha: string; candidate: boolean };

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const sessionId = (await params).id;
  const context = await getCandidateReviewMutationContext(sessionId, user.id);
  if (!context) return Response.json({ error: "Session not found" }, { status: 404 });
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
      mergeCommitSha = (await squashMergePullRequest(config, context.installationId, repository, context.pullRequestNumber, context.candidateSha)).sha;
      review = await getPullRequestReview(config, context.installationId, repository, context.pullRequestNumber);
      await reconcileCandidateReview(sessionId, context.candidateId, review);
    }
    if (!review.merged || !mergeCommitSha || review.mergeCommitSha !== mergeCommitSha) {
      return Response.json({ error: "GitHub did not confirm the squash merge" }, { status: 502 });
    }
    await markCandidateMerged(sessionId, context.candidateId, user.id, mergeCommitSha);
    const cleanup = await cleanupBranches(config, context, repository);
    const revision = await finishCandidateCleanup(
      sessionId,
      context.candidateId,
      cleanup.deletedRunIds,
      cleanup.candidateDeleted,
      cleanup.complete,
    );
    const floor = await getFloorSnapshot(sessionId, user.id);
    if (!floor) return Response.json({ error: "Session not found" }, { status: 404 });
    await notifyFloorChanged(sessionId, revision, ["queue", "repository", "runs", "review"]);
    return Response.json({ floor });
  } catch (error) {
    if (error instanceof GitHubApiError) {
      const status = [403, 405, 409, 422].includes(error.status) ? 409 : 502;
      return Response.json({ error: `GitHub rejected the squash merge: ${error.message}` }, { status });
    }
    return Response.json({ error: "The pull request could not be merged safely" }, { status: 502 });
  }
}

async function cleanupBranches(
  config: ReturnType<typeof getGitHubAppConfig>,
  context: NonNullable<Awaited<ReturnType<typeof getCandidateReviewMutationContext>>>,
  repository: GitHubRepositoryOption,
) {
  const targets: CleanupTarget[] = [
    ...context.runs.filter((run) => !run.branchDeletedAt && run.expectedSha).map((run) => ({ id: run.id, name: run.branchName, sha: run.expectedSha, candidate: false })),
    { id: null, name: context.candidateBranch, sha: context.candidateSha!, candidate: true },
  ];
  const safe: CleanupTarget[] = [];
  const alreadyMissing: CleanupTarget[] = [];
  for (const target of targets) {
    try {
      const observed = await getRepositoryRefSha(config, context.installationId, repository, target.name);
      if (observed === target.sha) safe.push(target);
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) alreadyMissing.push(target);
      else throw error;
    }
  }
  let deleted: CleanupTarget[] = [];
  if (config.testData) {
    for (const target of safe) {
      if (await deleteTestRepositoryBranchIfMatches(config, context.installationId, repository, target.name, target.sha)) deleted.push(target);
    }
  } else if (safe.length > 0) {
    const bindings = env as unknown as { SANDBOX?: DurableObjectNamespace<Sandbox> };
    if (!bindings.SANDBOX) throw new GitHubApiError("Safe branch cleanup is unavailable", 503);
    const sandbox = getSandbox(bindings.SANDBOX, `cleanup-v1-${context.candidateId}-${crypto.randomUUID()}`, { keepAlive: false, enableDefaultSession: false, normalizeId: true });
    try {
      const token = await createInstallationToken(config, context.installationId, context.repositoryId);
      const result = await sandbox.exec("node /opt/openfloor/cleanup-branches.mjs", {
        timeout: 5 * 60 * 1000,
        env: {
          OPENFLOOR_CLEANUP_ROOT: `/workspace/cleanup-${context.candidateId}`,
          OPENFLOOR_REPOSITORY_URL: `https://github.com/${context.repositoryOwner}/${context.repositoryName}.git`,
          OPENFLOOR_GITHUB_TOKEN: token,
          OPENFLOOR_BRANCHES: JSON.stringify(safe.map((target) => ({ name: target.name, sha: target.sha }))),
        },
      });
      if (!result.success) throw new GitHubApiError("Trusted branch cleanup failed", 502);
      const output = JSON.parse(result.stdout.trim()) as { deleted?: string[] };
      deleted = safe.filter((target) => output.deleted?.includes(target.name));
    } finally {
      await sandbox.destroy().catch(() => undefined);
    }
  }
  const cleared = [...alreadyMissing, ...deleted];
  return {
    deletedRunIds: cleared.flatMap((target) => target.id ? [target.id] : []),
    candidateDeleted: cleared.some((target) => target.candidate),
    complete: cleared.length === targets.length,
  };
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
