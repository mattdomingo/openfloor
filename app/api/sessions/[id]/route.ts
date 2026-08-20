import { deleteSession, updateSessionObjective } from "@/db/sessions";
import { mutationErrorResponse } from "@/lib/floor-api";
import { notifyMembersChanged, notifySessionChanged } from "@/lib/presence-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { parseObjectiveInput } from "@/lib/validation";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const input = parseObjectiveInput(body);
  if (!input) return Response.json({ error: "Objective must be 2,000 characters or fewer" }, { status: 400 });

  try {
    const session = await updateSessionObjective((await params).id, user.id, input.objective);
    if (!session) return Response.json({ error: "Session not found" }, { status: 404 });
    await notifySessionChanged(session.id, { objective: session.objective, updatedAt: session.updatedAt });
    return Response.json({ session });
  } catch (error) {
    return mutationErrorResponse(error);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const sessionId = (await params).id;
  const result = await deleteSession(sessionId, user.id);
  if (result === "missing") return Response.json({ error: "Session not found" }, { status: 404 });
  if (result === "forbidden") return Response.json({ error: "Only the owner can delete this session" }, { status: 403 });
  if (result === "repository_state") return Response.json({ error: "This session has repository history and cannot be deleted until safe external cleanup is available" }, { status: 409 });
  // members.changed makes open tabs refetch, hit the 404, and leave for /home.
  await notifyMembersChanged(sessionId);
  return new Response(null, { status: 204 });
}
