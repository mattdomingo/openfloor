import { removeMember, restoreMember } from "@/db/sessions";
import { mutationErrorResponse } from "@/lib/floor-api";
import { disconnectPresenceUser, notifyFloorChanged, notifyMembersChanged } from "@/lib/presence-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string; memberId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id: sessionId, memberId } = await params;
  try {
    const result = await removeMember(sessionId, user.id, memberId);
    if (result === "missing") return Response.json({ error: "Session not found" }, { status: 404 });
    if (result === "forbidden") return Response.json({ error: "Only the owner can remove a member" }, { status: 403 });
    if (result === "self") return Response.json({ error: "You can't remove yourself" }, { status: 409 });
    if (result === "owner_target") return Response.json({ error: "The owner can't be removed" }, { status: 409 });
    await disconnectPresenceUser(sessionId, memberId, "removed");
    await notifyMembersChanged(sessionId);
    // Agent ownership and the assignment roster both changed underneath
    // other members' floors — without this they'd keep rendering the
    // removed member as an agent owner until an unrelated refetch.
    await notifyFloorChanged(sessionId, result.revision, ["agents", "assignments"]);
    return new Response(null, { status: 204 });
  } catch (error) {
    return mutationErrorResponse(error);
  }
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string; memberId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id: sessionId, memberId } = await params;
  try {
    const result = await restoreMember(sessionId, user.id, memberId);
    if (result === "missing") return Response.json({ error: "Session not found" }, { status: 404 });
    if (result === "forbidden") return Response.json({ error: "Only the owner can restore a member" }, { status: 403 });
    if (result === "full") return Response.json({ error: "This session has reached its seat limit." }, { status: 403 });
    await notifyMembersChanged(sessionId);
    return new Response(null, { status: 204 });
  } catch (error) {
    return mutationErrorResponse(error);
  }
}
