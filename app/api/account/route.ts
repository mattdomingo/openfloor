import { deleteAccount, getAccountDeletionBlockers, listOwnedSessionsWithLiveCandidate } from "@/db/sessions";
import { deleteAvatar } from "@/lib/account-avatar";
import { abandonSessionCandidate } from "@/lib/candidate-abandon";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { cancelStripeSubscriptionsForAccount } from "@/lib/stripe-billing";

// Bounds the GitHub/Sandbox work account deletion is willing to do inline:
// each attempted branch delete spins a throwaway Cloudflare Sandbox with up
// to a 5-minute exec timeout (lib/repository-cleanup.ts). An account owning
// many repository-connected sessions must not blow the Worker's request
// budget mid-deletion — branches beyond the cap are simply reported as
// orphaned instead of attempted.
const MAX_BRANCH_DELETE_ATTEMPTS = 3;

export async function DELETE(request: Request) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;

  const body = (await request.json().catch(() => null)) as { confirm?: unknown; deleteBranches?: unknown } | null;
  if (body?.confirm !== "DELETE") {
    return Response.json({ error: "Type DELETE to confirm account deletion." }, { status: 400 });
  }
  const deleteBranches = Boolean(body?.deleteBranches);

  // Repository state on an owned session no longer blocks account deletion
  // — only an in-progress GitHub integration does (a Workflow actively
  // pushing under a D1 lease). See db/sessions.ts's getAccountDeletionBlockers.
  const before = await getAccountDeletionBlockers(user.id);
  if (before.blocked.length > 0) {
    return Response.json(
      { error: "Finish or disconnect the repository work in these sessions first.", code: "sessions_blocked", sessions: before.blocked },
      { status: 409 },
    );
  }
  try {
    await cancelStripeSubscriptionsForAccount(user.id);
  } catch {
    return Response.json({ error: "Unable to cancel billing. Your account was not deleted." }, { status: 502 });
  }

  // Every owned session's repository_candidates row cascades away with the
  // session in deleteAccount's D1 batch below regardless of what happens
  // here — this only attempts GitHub branch cleanup (when asked) before
  // that context is lost, and reports what will end up orphaned either way.
  const live = await listOwnedSessionsWithLiveCandidate(user.id);
  const orphanedBranches: string[] = [];
  for (const [index, candidate] of live.entries()) {
    if (deleteBranches && index < MAX_BRANCH_DELETE_ATTEMPTS) {
      // A "blocked" outcome here (an integration lease taken after the
      // getAccountDeletionBlockers check above) is a race deleteAccount's
      // own recheck below is the authority on — treat it the same as any
      // other branch-delete failure: report it orphaned and keep going.
      const attempt = await abandonSessionCandidate(candidate.sessionId, user.id, { deleteBranch: true });
      if (attempt.outcome !== "abandoned" || !attempt.branchDeleted) orphanedBranches.push(candidate.branch);
      continue;
    }
    orphanedBranches.push(candidate.branch);
  }

  const result = await deleteAccount(user.id);
  if ("blocked" in result) {
    return Response.json(
      {
        error: "Finish or disconnect the repository work in these sessions first.",
        code: "sessions_blocked",
        sessions: result.sessions,
      },
      { status: 409 },
    );
  }

  // Best-effort: the account row is already scrubbed regardless of whether
  // this succeeds, and GET /api/account/avatar/[userId] 404s off avatar_key
  // (now null) rather than off what's actually left in R2.
  await deleteAvatar(user.id);
  return Response.json({ deleted: true, orphanedBranches });
}
