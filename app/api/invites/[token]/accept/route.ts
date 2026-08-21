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
  await notifyMembersChanged(sessionId);
  return Response.json({ sessionId });
}
