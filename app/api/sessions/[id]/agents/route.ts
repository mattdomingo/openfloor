import { createFloorAgent } from "@/db/floor";
import { disabledRunProviders } from "@/lib/agent-run-start";
import { floorMutationResponse, mutationErrorResponse, readJson } from "@/lib/floor-api";
import { pokeSessionRouter } from "@/lib/router-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { parseAgentInput } from "@/lib/validation";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const input = parseAgentInput(await readJson(request));
  if (!input) return Response.json({ error: "Name, role, task, and a valid owner are required" }, { status: 400 });
  // Same convention as the run gates: while a provider's rollout flag is off,
  // its option is hidden in the UI and a direct request is refused, so no
  // agent exists that can never execute.
  if (disabledRunProviders().has(input.provider)) {
    return Response.json({ error: "Claude execution is not enabled" }, { status: 503 });
  }
  const { id } = await params;
  try {
    const floor = await createFloorAgent(id, user.id, input);
    if (!floor) return Response.json({ error: "Session not found" }, { status: 404 });
    await pokeSessionRouter(id, "agent_changed");
    return floorMutationResponse(id, floor, ["agents"], 201);
  } catch (error) {
    return mutationErrorResponse(error);
  }
}
