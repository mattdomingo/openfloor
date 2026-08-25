import { getFloorSnapshot } from "@/db/floor";
import { setSessionRoutingSettings } from "@/db/sessions";
import { floorMutationResponse, mutationErrorResponse, readJson } from "@/lib/floor-api";
import { pokeSessionRouter } from "@/lib/router-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { parseRoutingSettingsInput } from "@/lib/validation";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const input = parseRoutingSettingsInput(await readJson(request));
  if (!input) return Response.json({ error: "Provide autoDispatch or autoResolveConflicts as a boolean" }, { status: 400 });
  const { id } = await params;
  try {
    const updated = await setSessionRoutingSettings(id, user.id, input);
    if (!updated) return Response.json({ error: "Session not found" }, { status: 404 });
    const floor = await getFloorSnapshot(id, user.id);
    if (!floor) return Response.json({ error: "Session not found" }, { status: 404 });
    if (input.autoDispatch || input.autoResolveConflicts) await pokeSessionRouter(id, "toggle");
    return floorMutationResponse(id, floor, ["queue", "review"]);
  } catch (error) {
    return mutationErrorResponse(error);
  }
}
