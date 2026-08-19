import { updateFloorAssignment } from "@/db/floor";
import { floorMutationResponse, mutationErrorResponse, readJson } from "@/lib/floor-api";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { parseAssignmentInput } from "@/lib/validation";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; memberId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const input = parseAssignmentInput(await readJson(request));
  if (!input) return Response.json({ error: "Assignment must be under 2,000 characters" }, { status: 400 });
  const { id, memberId } = await params;
  try {
    const floor = await updateFloorAssignment(id, user.id, memberId, input);
    return floor
      ? floorMutationResponse(id, floor, ["assignments"])
      : Response.json({ error: "Session not found" }, { status: 404 });
  } catch (error) {
    return mutationErrorResponse(error);
  }
}
