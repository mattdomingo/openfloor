import { setFloorQueueItemPaused } from "@/db/floor";
import { floorMutationResponse, mutationErrorResponse, readJson } from "@/lib/floor-api";
import { pokeSessionRouter } from "@/lib/router-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { parseQueueItemPauseInput } from "@/lib/validation";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; queueItemId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const input = parseQueueItemPauseInput(await readJson(request));
  if (!input) return Response.json({ error: "A paused flag is required" }, { status: 400 });
  const { id, queueItemId } = await params;
  try {
    const floor = await setFloorQueueItemPaused(id, user.id, queueItemId, input.paused);
    if (!floor) return Response.json({ error: "Session not found" }, { status: 404 });
    if (!input.paused) await pokeSessionRouter(id, "enqueue");
    return floorMutationResponse(id, floor, ["queue"]);
  } catch (error) {
    return mutationErrorResponse(error);
  }
}
