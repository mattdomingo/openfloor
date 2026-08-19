import { FloorConflictError, FloorTargetError, mergeFloorQueue } from "@/db/floor";
import { floorMutationResponse, readJson } from "@/lib/floor-api";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { parseQueueMergeInput } from "@/lib/validation";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const input = parseQueueMergeInput(await readJson(request));
  if (!input) return Response.json({ error: "At least two unique queue item IDs are required" }, { status: 400 });
  const { id } = await params;
  try {
    const floor = await mergeFloorQueue(id, user.id, input.itemIds);
    return floor
      ? floorMutationResponse(id, floor, ["queue"])
      : Response.json({ error: "Session not found" }, { status: 404 });
  } catch (error) {
    if (error instanceof FloorConflictError) return Response.json({ error: error.message }, { status: 409 });
    if (error instanceof FloorTargetError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
