import { resumeAllFloorAgents } from "@/db/floor";
import { activeOwnerErrorResponse, floorMutationResponse, mutationErrorResponse } from "@/lib/floor-api";
import { pokeSessionRouter } from "@/lib/router-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id } = await params;
  const ownerError = await activeOwnerErrorResponse(id, user.id);
  if (ownerError) return ownerError;
  try {
    const floor = await resumeAllFloorAgents(id, user.id);
    if (!floor) return Response.json({ error: "Session not found" }, { status: 404 });
    await pokeSessionRouter(id, "agent_changed");
    return floorMutationResponse(id, floor, ["agents"]);
  } catch (error) {
    return mutationErrorResponse(error);
  }
}
