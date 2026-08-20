import { getFloorSnapshot } from "@/db/floor";
import { startQueueItemRun } from "@/lib/agent-run-start";
import { notifyFloorChanged } from "@/lib/presence-server";
import { pokeSessionRouter } from "@/lib/router-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { activeOwnerErrorResponse, mutationErrorResponse } from "@/lib/floor-api";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string; queueItemId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id: sessionId, queueItemId } = await params;
  const ownerError = await activeOwnerErrorResponse(sessionId, user.id);
  if (ownerError) return ownerError;
  let result;
  try {
    result = await startQueueItemRun(sessionId, queueItemId, user.id);
  } catch (error) {
    try { return mutationErrorResponse(error); } catch { /* continue with run mapping */ }
    return Response.json({ error: "Agent run could not be started" }, { status: 502 });
  }
  if (!result.ok) {
    if (result.kind === "disabled") return Response.json({ error: result.message }, { status: 503 });
    if (result.kind === "not_ready") return Response.json({ error: result.message }, { status: result.message === "Session not found" ? 404 : 409 });
    return Response.json({ error: result.message }, { status: 409 });
  }
  const floor = await getFloorSnapshot(sessionId, user.id);
  if (!floor) return Response.json({ error: "Session not found" }, { status: 404 });
  await notifyFloorChanged(sessionId, floor.revision, ["queue", "runs", "review"]);
  await pokeSessionRouter(sessionId, "run_completed");
  return Response.json({ floor }, { status: 202 });
}
