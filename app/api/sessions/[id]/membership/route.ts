import { getDb } from "@/db";
import { getFloorSnapshot } from "@/db/floor";
import { getActiveMembershipRole } from "@/db/sessions";
import { floorMutationResponse, mutationErrorResponse } from "@/lib/floor-api";
import { pokeSessionRouter } from "@/lib/router-server";
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

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id } = await params;
  try {
    if (!await getActiveMembershipRole(id, user.id)) return Response.json({ error: "Session not found" }, { status: 404 });
    const body = await request.json().catch(() => null) as { autoAgentsEnabled?: unknown } | null;
    if (typeof body?.autoAgentsEnabled !== "boolean") return Response.json({ error: "autoAgentsEnabled must be a boolean" }, { status: 400 });
    const database = getDb();
    await database.batch([
      database.prepare("UPDATE session_members SET auto_agents_enabled = ? WHERE session_id = ? AND user_id = ? AND removed_at IS NULL AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND ended_at IS NULL)").bind(body.autoAgentsEnabled ? 1 : 0, id, user.id, id),
      database.prepare("UPDATE sessions SET floor_revision = floor_revision + 1 WHERE id = ? AND ended_at IS NULL").bind(id),
    ]);
    await pokeSessionRouter(id, "toggle");
    const floor = await getFloorSnapshot(id, user.id);
    return floor ? floorMutationResponse(id, floor, ["agents", "queue"]) : Response.json({ error: "Session not found" }, { status: 404 });
  } catch (error) { return mutationErrorResponse(error); }
}
