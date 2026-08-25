import { requestConflictResolution } from "@/db/conflicts";
import { getFloorSnapshot } from "@/db/floor";
import { floorMutationResponse, mutationErrorResponse } from "@/lib/floor-api";
import { pokeSessionRouter } from "@/lib/router-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string; caseId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id: sessionId, caseId } = await params;
  try {
    const requested = await requestConflictResolution(sessionId, caseId, user.id);
    if (requested === null) return Response.json({ error: "Session not found" }, { status: 404 });
    if (!requested) return Response.json({ error: "This conflict case is not available to resolve." }, { status: 409 });
    await pokeSessionRouter(sessionId, "toggle");
    const floor = await getFloorSnapshot(sessionId, user.id);
    if (!floor) return Response.json({ error: "Session not found" }, { status: 404 });
    return floorMutationResponse(sessionId, floor, ["queue", "runs", "review"], 202);
  } catch (error) {
    return mutationErrorResponse(error);
  }
}
