import { deleteFloorQueueItem, setFloorQueueItemAgent } from "@/db/floor";
import { floorMutationResponse, mutationErrorResponse, readJson } from "@/lib/floor-api";
import { pokeSessionRouter } from "@/lib/router-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { parseQueueItemTargetInput } from "@/lib/validation";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string; queueItemId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id, queueItemId } = await params;
  try {
    const floor = await deleteFloorQueueItem(id, user.id, queueItemId);
    if (!floor) return Response.json({ error: "Session not found" }, { status: 404 });
    await pokeSessionRouter(id, "enqueue");
    return floorMutationResponse(id, floor, ["queue"]);
  } catch (error) {
    return mutationErrorResponse(error);
  }
}

// Manually targets an unassigned queued item. This is the only way to reach
// the Run button on a prompt submitted with "Auto" while auto-dispatch is
// off — the router's assign phase (the only other assigner) never runs in
// that case.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; queueItemId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const input = parseQueueItemTargetInput(await readJson(request));
  if (!input) return Response.json({ error: "A target agent is required" }, { status: 400 });
  const { id, queueItemId } = await params;
  try {
    const floor = await setFloorQueueItemAgent(id, user.id, queueItemId, input.agentId);
    if (!floor) return Response.json({ error: "Session not found" }, { status: 404 });
    await pokeSessionRouter(id, "enqueue");
    return floorMutationResponse(id, floor, ["queue"]);
  } catch (error) {
    return mutationErrorResponse(error);
  }
}
