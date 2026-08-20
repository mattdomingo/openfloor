import { createFloorAgent } from "@/db/floor";
import { floorMutationResponse, mutationErrorResponse, readJson } from "@/lib/floor-api";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { parseAgentInput } from "@/lib/validation";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const input = parseAgentInput(await readJson(request));
  if (!input) return Response.json({ error: "Name, role, task, and a valid owner are required" }, { status: 400 });
  const { id } = await params;
  try {
    const floor = await createFloorAgent(id, user.id, input);
    return floor
      ? floorMutationResponse(id, floor, ["agents"], 201)
      : Response.json({ error: "Session not found" }, { status: 404 });
  } catch (error) {
    return mutationErrorResponse(error);
  }
}
