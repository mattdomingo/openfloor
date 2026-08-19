import { prepareConflictedRunRetry } from "@/db/runs";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { POST as startQueueRun } from "../../../queue/[queueItemId]/run/route";

export async function POST(request: Request, { params }: { params: Promise<{ id: string; runId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id: sessionId, runId } = await params;
  const queueItemId = await prepareConflictedRunRetry(sessionId, runId, user.id);
  if (!queueItemId) return Response.json({ error: "Session not found" }, { status: 404 });
  return startQueueRun(request, { params: Promise.resolve({ id: sessionId, queueItemId }) });
}
