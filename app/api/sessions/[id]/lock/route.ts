import { setSessionLocked } from "@/db/sessions";
import { mutationErrorResponse } from "@/lib/floor-api";
import { notifySessionLocked } from "@/lib/presence-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";

async function setLocked(sessionId: string, userId: string, locked: boolean) {
  try {
    const result = await setSessionLocked(sessionId, userId, locked);
    if (!result) return Response.json({ error: "Session not found" }, { status: 404 });
    await notifySessionLocked(sessionId, result.lockedAt);
    return new Response(null, { status: 204 });
  } catch (error) {
    return mutationErrorResponse(error);
  }
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  return setLocked((await params).id, user.id, true);
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  return setLocked((await params).id, user.id, false);
}
