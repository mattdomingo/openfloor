import { pauseFloorAgent } from "@/db/floor";
import { floorMutationResponse, mutationErrorResponse, readJson } from "@/lib/floor-api";
import { pokeSessionRouter } from "@/lib/router-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { parseAgentPauseInput } from "@/lib/validation";

// Any member — pausing never touches an in-flight run, it only blocks new
// router assignment/dispatch (see db/floor.ts's pauseFloorAgent).
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; agentId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const input = parseAgentPauseInput(await readJson(request));
  if (!input) return Response.json({ error: "A paused flag is required" }, { status: 400 });
  const { id, agentId } = await params;
  try {
    const floor = await pauseFloorAgent(id, user.id, agentId, input.paused);
    if (!floor) return Response.json({ error: "Session not found" }, { status: 404 });
    if (!input.paused) await pokeSessionRouter(id, "agent_changed");
    return floorMutationResponse(id, floor, ["agents"]);
  } catch (error) {
    return mutationErrorResponse(error);
  }
}
