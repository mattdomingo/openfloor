import { prepareConflictedRunRetry } from "@/db/runs";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { POST as startQueueRun } from "../../../queue/[queueItemId]/run/route";
import { activeOwnerErrorResponse, mutationErrorResponse } from "@/lib/floor-api";

export async function POST(request: Request, { params }: { params: Promise<{ id: string; runId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id: sessionId, runId } = await params;
  const ownerError = await activeOwnerErrorResponse(sessionId, user.id);
  if (ownerError) return ownerError;
  let queueItemId;
  try {
    queueItemId = await prepareConflictedRunRetry(sessionId, runId, user.id);
  } catch (error) {
    return mutationErrorResponse(error);
  }
  if (!queueItemId) return Response.json({ error: "Session not found" }, { status: 404 });
  return startQueueRun(request, { params: Promise.resolve({ id: sessionId, queueItemId }) });
}
