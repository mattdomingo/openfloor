import { FloorConflictError, reorderFloorQueue } from "@/db/floor";
import { floorMutationResponse, readJson } from "@/lib/floor-api";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { parseQueueOrderInput } from "@/lib/validation";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const input = parseQueueOrderInput(await readJson(request));
  if (!input) return Response.json({ error: "A unique list of queue item IDs is required" }, { status: 400 });
  const { id } = await params;
  try {
    const floor = await reorderFloorQueue(id, user.id, input.itemIds);
    return floor
      ? floorMutationResponse(id, floor, ["queue"])
      : Response.json({ error: "Session not found" }, { status: 404 });
  } catch (error) {
    if (error instanceof FloorConflictError) return Response.json({ error: error.message }, { status: 409 });
    throw error;
  }
}
