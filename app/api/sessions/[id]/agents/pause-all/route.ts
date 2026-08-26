import { pauseAllFloorAgents } from "@/db/floor";
import { activeOwnerErrorResponse, floorMutationResponse, mutationErrorResponse } from "@/lib/floor-api";
import { isApiError, requireApiUser } from "@/lib/server-auth";

// Owner-only master-control lever over the "any member" per-agent pause
// button — pauses every persistent, non-deleted agent in the session.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id } = await params;
  const ownerError = await activeOwnerErrorResponse(id, user.id);
  if (ownerError) return ownerError;
  try {
    const floor = await pauseAllFloorAgents(id, user.id);
    if (!floor) return Response.json({ error: "Session not found" }, { status: 404 });
    return floorMutationResponse(id, floor, ["agents"]);
  } catch (error) {
    return mutationErrorResponse(error);
  }
}
