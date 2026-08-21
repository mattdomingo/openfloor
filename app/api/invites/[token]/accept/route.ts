import { acceptInvite } from "@/db/sessions";
import { getInviteSigningSecret } from "@/db";
import { verifyInviteToken } from "@/lib/invites";
import { notifyMembersChanged } from "@/lib/presence-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";

export async function POST(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const inviteId = await verifyInviteToken((await params).token, getInviteSigningSecret());
  if (!inviteId) return Response.json({ error: "Invite not found" }, { status: 404 });
  const sessionId = await acceptInvite(inviteId, user.id);
  if (!sessionId) return Response.json({ error: "Invite not found" }, { status: 404 });
  if (sessionId === "full") {
    return Response.json({ error: "This session has reached its seat limit." }, { status: 403 });
  }
  // Departure from 404 concealment on purpose: the bearer holds a valid
  // signed invite token, so the session's existence is already known to
  // them — an honest reason beats a 404 that reads as a broken link.
  if (sessionId === "removed") {
    return Response.json({ error: "The owner removed you from this session." }, { status: 403 });
  }
  if (sessionId === "locked") {
    return Response.json({ error: "This session is locked. Ask the owner to unlock it." }, { status: 403 });
  }
  await notifyMembersChanged(sessionId);
  return Response.json({ sessionId });
}
