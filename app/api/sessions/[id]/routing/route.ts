import { getFloorSnapshot } from "@/db/floor";
import { setSessionRoutingSettings } from "@/db/sessions";
import { activeOwnerErrorResponse, floorMutationResponse, mutationErrorResponse, readJson } from "@/lib/floor-api";
import { pokeSessionRouter } from "@/lib/router-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { parseRoutingSettingsInput } from "@/lib/validation";
import { disabledRunProviders } from "@/lib/provider-rollout";
import { providerLabel } from "@/lib/provider-credentials";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const input = parseRoutingSettingsInput(await readJson(request));
  if (!input) return Response.json({ error: "Provide a valid routing or generated-agent setting" }, { status: 400 });
  if (input.autoAgentProvider !== undefined) return Response.json({ error: "Choose your account default API key in Settings." }, { status: 400 });
  const { id } = await params;
  const ownerError = await activeOwnerErrorResponse(id, user.id);
  if (ownerError) return ownerError;
  if (input.autoAgentProvider && disabledRunProviders().has(input.autoAgentProvider)) {
    return Response.json({ error: `${providerLabel(input.autoAgentProvider)} execution is not enabled` }, { status: 503 });
  }
  try {
    const updated = await setSessionRoutingSettings(id, user.id, input);
    if (!updated) return Response.json({ error: "Session not found" }, { status: 404 });
    if (input.autoDispatch !== undefined || input.autoProvisionAgents !== undefined || input.autoAgentProvider !== undefined || input.autoResolveConflicts !== undefined) {
      await pokeSessionRouter(id, "toggle");
    }
    const floor = await getFloorSnapshot(id, user.id);
    if (!floor) return Response.json({ error: "Session not found" }, { status: 404 });
    return floorMutationResponse(id, floor, ["agents", "queue", "review"]);
  } catch (error) {
    return mutationErrorResponse(error);
  }
}
