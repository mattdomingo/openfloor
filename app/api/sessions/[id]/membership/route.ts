import { leaveSession } from "@/db/sessions";
import { disconnectPresenceUser, notifyMembersChanged } from "@/lib/presence-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const sessionId = (await params).id;
  const result = await leaveSession(sessionId, user.id);
  if (result === "owner") return Response.json({ error: "Owners cannot leave their session" }, { status: 409 });
  if (result === "missing") return Response.json({ error: "Session not found" }, { status: 404 });
  await disconnectPresenceUser(sessionId, user.id);
  await notifyMembersChanged(sessionId);
  return new Response(null, { status: 204 });
}
