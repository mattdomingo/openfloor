import { getFloorSnapshot } from "@/db/floor";
import { startAgentRunRollback } from "@/lib/agent-run-rollback";
import { mutationErrorResponse } from "@/lib/floor-api";
import { notifyFloorChanged } from "@/lib/presence-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string; runId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id: sessionId, runId } = await params;
  let result;
  try {
    result = await startAgentRunRollback(sessionId, runId, user.id);
  } catch (error) {
    try { return mutationErrorResponse(error); } catch { /* continue with rollback mapping */ }
    return Response.json({ error: "Rollback could not be started" }, { status: 502 });
  }
  if (!result.ok) {
    return Response.json({ error: result.message }, { status: result.kind === "not_ready" && result.message === "Session not found" ? 404 : 409 });
  }
  const floor = await getFloorSnapshot(sessionId, user.id);
  if (!floor) return Response.json({ error: "Session not found" }, { status: 404 });
  await notifyFloorChanged(sessionId, floor.revision, ["repository", "runs", "review"]);
  return Response.json({ floor }, { status: 202 });
}
