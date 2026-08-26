import { deleteFloorAgent, updateFloorAgentSettings } from "@/db/floor";
import { floorMutationResponse, mutationErrorResponse, readJson } from "@/lib/floor-api";
import { pokeSessionRouter } from "@/lib/router-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { parseAgentSettingsInput } from "@/lib/validation";

// Field edits ({ task?, model?, credentialKind? }) on the agent resource the
// same members already PATCH — deliberately not /model or /billing
// sub-routes: pause and stop are separate routes because they are separate
// verbs with different authorization; these are field edits.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; agentId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const input = parseAgentSettingsInput(await readJson(request));
  if (!input) return Response.json({ error: "Provide a task under 1,000 characters, a model, or a billing credential to change" }, { status: 400 });
  const { id, agentId } = await params;
  try {
    const floor = await updateFloorAgentSettings(id, user.id, agentId, input);
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
