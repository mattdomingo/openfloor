import { updateFloorQueuePrompt } from "@/db/floor";
import { floorMutationResponse, mutationErrorResponse, readJson } from "@/lib/floor-api";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { parseQueuePromptTextInput } from "@/lib/validation";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; queueItemId: string; promptId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const input = parseQueuePromptTextInput(await readJson(request));
  if (!input) return Response.json({ error: "A prompt under 4,000 characters is required" }, { status: 400 });
  const { id, queueItemId, promptId } = await params;
  try {
    const floor = await updateFloorQueuePrompt(id, user.id, queueItemId, promptId, input.text);
    if (!floor) return Response.json({ error: "Session not found" }, { status: 404 });
    return floorMutationResponse(id, floor, ["queue"]);
  } catch (error) {
    return mutationErrorResponse(error);
  }
}
