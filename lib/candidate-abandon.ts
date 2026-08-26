import { getDb, getGitHubAppConfig, type D1DatabaseLike } from "@/db";
import { finishCandidateCleanup, getCandidateBranchDeleteContext, getRepositoryFloorRevision, markCandidateAbandoned } from "@/db/repositories";
import { deleteVerifiedBranches, type CleanupTarget } from "@/lib/repository-cleanup";
import type { GitHubRepositoryOption } from "@/lib/session-types";

export type AbandonCandidateResult =
  // No live candidate to abandon: no repository_candidates row exists at
  // all, the caller isn't the session's owner, or the latest one already
  // merged. Every current caller has already confirmed owner + session
  // existence before calling this, so in practice this only ever means
  // "there's nothing to abandon" — never an auth gap.
  | { outcome: "no_candidate" }
  | { outcome: "blocked"; runId: string }
  | { outcome: "abandoned"; branch: string; branchDeleted: boolean; revision: number };

/* The one place a still-live repository_candidates row is retired without a
   GitHub merge. Reused by session deletion (deleteSession's candidate
   option), account deletion (deleteAccount's pre-flight), and the
   standalone "Abandon candidate" action in Review — one code path so all
   three get the same lease guard and the same best-effort branch cleanup.

   GitHub/Sandbox work (when deleteBranch is requested) always runs before
   any D1 write, and its failure never blocks the write: a branch that
   deleteVerifiedBranches could not verify-delete is reported as still live
   on GitHub (branchDeleted: false) rather than silently dropped, and the
   candidate is abandoned in D1 regardless.

   Idempotent and retryable, the same way the post-merge branch-delete route
   is: calling this again on an already-abandoned candidate whose branch
   didn't verify-delete the first time (a transient GitHub/Sandbox failure)
   retries only the branch cleanup rather than erroring. */
export async function abandonSessionCandidate(
  sessionId: string,
  userId: string,
  options: { deleteBranch: boolean },
  database: D1DatabaseLike = getDb(),
): Promise<AbandonCandidateResult> {
  const context = await getCandidateBranchDeleteContext(sessionId, userId, database);
  if (!context || context.mergedAt != null) return { outcome: "no_candidate" };
  if (context.integrationRunId) return { outcome: "blocked", runId: context.integrationRunId };

  const alreadyAbandoned = context.abandonedAt != null;
  let branchDeleted = context.branchDeletedAt != null;
  let cleanup: { deletedRunIds: string[]; candidateDeleted: boolean; complete: boolean } | null = null;
  if (options.deleteBranch && !branchDeleted && context.candidateSha) {
    try {
      const config = getGitHubAppConfig();
      const repository: GitHubRepositoryOption = {
        id: context.repositoryId,
        nodeId: "abandon-not-required",
        owner: context.repositoryOwner,
        name: context.repositoryName,
        fullName: context.repositoryFullName,
        private: context.repositoryPrivate,
        defaultBranch: context.defaultBranch,
      };
      const targets: CleanupTarget[] = [
        ...context.runs.map((run) => ({ id: run.id, name: run.branchName, sha: run.expectedSha, candidate: false })),
        { id: null, name: context.candidateBranch, sha: context.candidateSha, candidate: true },
      ];
      cleanup = await deleteVerifiedBranches(config, context.installationId, repository, targets, context.candidateId);
      branchDeleted = cleanup.candidateDeleted;
    } catch {
      // Best-effort: the branch is left orphaned on GitHub; the candidate is
      // still abandoned in D1 below so the caller (session/account delete,
      // or an explicit Review abandon) never dead-ends on any optional
      // cleanup failure. deleteVerifiedBranches can reject before GitHub
      // returns a typed error (configuration, token, Sandbox, or parsing),
      // and every such case is equally non-authoritative for abandonment.
    }
  }

  let revision = alreadyAbandoned
    ? await getRepositoryFloorRevision(sessionId, database)
    : await markCandidateAbandoned(sessionId, context.candidateId, database);
  if (cleanup) {
    revision = await finishCandidateCleanup(sessionId, context.candidateId, cleanup.deletedRunIds, cleanup.candidateDeleted, cleanup.complete, database);
  }
  return { outcome: "abandoned", branch: context.candidateBranch, branchDeleted, revision };
}
