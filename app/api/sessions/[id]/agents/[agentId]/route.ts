import { deleteFloorAgent, updateFloorAgentTask } from "@/db/floor";
import { floorMutationResponse, mutationErrorResponse, readJson } from "@/lib/floor-api";
import { pokeSessionRouter } from "@/lib/router-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { parseAgentTaskInput } from "@/lib/validation";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; agentId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const input = parseAgentTaskInput(await readJson(request));
  if (!input) return Response.json({ error: "Description is required and must be under 1,000 characters" }, { status: 400 });
  const { id, agentId } = await params;
  try {
    const floor = await updateFloorAgentTask(id, user.id, agentId, input);
    return floor
      ? floorMutationResponse(id, floor, ["agents"])
      : Response.json({ error: "Session not found" }, { status: 404 });
  } catch (error) {
    return mutationErrorResponse(error);
  }
}

// Soft-deletes a persistent agent (any member — same looseness as PATCH
// above) and unassigns it from any still-queued/paused items so the router
// can re-route them. Refuses with 409 while the agent has real in-flight
// work; see db/floor.ts's deleteFloorAgent.
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string; agentId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id, agentId } = await params;
  try {
    const floor = await deleteFloorAgent(id, user.id, agentId);
    if (!floor) return Response.json({ error: "Session not found" }, { status: 404 });
    await pokeSessionRouter(id, "agent_changed");
    return floorMutationResponse(id, floor, ["agents", "queue"]);
  } catch (error) {
    return mutationErrorResponse(error);
  }
}
