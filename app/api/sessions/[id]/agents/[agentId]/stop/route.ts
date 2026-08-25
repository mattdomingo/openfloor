import { stopFloorAgent } from "@/db/floor";
import { floorMutationResponse, mutationErrorResponse } from "@/lib/floor-api";
import { pokeSessionRouter } from "@/lib/router-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";

// Any member — always blocks new dispatch immediately. Cancelling an
// in-flight run is a separate, owner-only privilege applied inside
// db/floor.ts's stopFloorAgent; a non-owner's Stop behaves like Pause when
// a run is active.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string; agentId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id, agentId } = await params;
  try {
    const floor = await stopFloorAgent(id, user.id, agentId);
    if (!floor) return Response.json({ error: "Session not found" }, { status: 404 });
    await pokeSessionRouter(id, "agent_changed");
    return floorMutationResponse(id, floor, ["agents", "queue", "runs"]);
  } catch (error) {
    return mutationErrorResponse(error);
  }
}
