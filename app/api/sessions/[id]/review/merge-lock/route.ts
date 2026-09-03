import { getFloorSnapshot } from "@/db/floor";
import { getCandidateReviewMutationContext, setCandidateMergeLocked } from "@/db/repositories";
import { activeOwnerErrorResponse, floorMutationResponse, mutationErrorResponse, readJson } from "@/lib/floor-api";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { parseMergeLockInput } from "@/lib/validation";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const input = parseMergeLockInput(await readJson(request));
  if (!input) return Response.json({ error: "Provide a valid merge lock state" }, { status: 400 });
  const sessionId = (await params).id;
  const ownerError = await activeOwnerErrorResponse(sessionId, user.id);
  if (ownerError) return ownerError;

  try {
    const context = await getCandidateReviewMutationContext(sessionId, user.id);
    if (!context) return Response.json({ error: "Session not found" }, { status: 404 });
    if (context.candidateStatus !== "active") {
      return Response.json({ error: "No active review candidate is available" }, { status: 409 });
    }
    await setCandidateMergeLocked(sessionId, context.candidateId, input.locked);
    const floor = await getFloorSnapshot(sessionId, user.id);
    if (!floor) return Response.json({ error: "Session not found" }, { status: 404 });
    return floorMutationResponse(sessionId, floor, ["repository", "review"]);
  } catch (error) {
    return mutationErrorResponse(error);
  }
}
