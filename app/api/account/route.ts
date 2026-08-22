import { deleteAccount, getAccountDeletionBlockers } from "@/db/sessions";
import { deleteAvatar } from "@/lib/account-avatar";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { cancelStripeSubscriptionsForAccount } from "@/lib/stripe-billing";

export async function DELETE(request: Request) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;

  const body = (await request.json().catch(() => null)) as { confirm?: unknown } | null;
  if (body?.confirm !== "DELETE") {
    return Response.json({ error: "Type DELETE to confirm account deletion." }, { status: 400 });
  }

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
  return Response.json({ deleted: true });
}
