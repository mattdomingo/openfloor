import { createFloorMessage } from "@/db/floor";
import { floorMutationResponse, mutationErrorResponse, readJson } from "@/lib/floor-api";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { parseMessageInput } from "@/lib/validation";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const input = parseMessageInput(await readJson(request));
  if (!input) return Response.json({ error: "A message under 4,000 characters is required" }, { status: 400 });
  const { id } = await params;
  try {
    const floor = await createFloorMessage(id, user.id, input);
    return floor
      ? floorMutationResponse(id, floor, ["messages"], 201)
      : Response.json({ error: "Session not found" }, { status: 404 });
  } catch (error) {
    return mutationErrorResponse(error);
  }
}
