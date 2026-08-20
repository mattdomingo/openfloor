import { deleteFloorQueueItem } from "@/db/floor";
import { floorMutationResponse, mutationErrorResponse } from "@/lib/floor-api";
import { pokeSessionRouter } from "@/lib/router-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";

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
