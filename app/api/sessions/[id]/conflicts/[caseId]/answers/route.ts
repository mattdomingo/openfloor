import { answerConflictQuestions } from "@/db/conflicts";
import { getFloorSnapshot } from "@/db/floor";
import { floorMutationResponse, mutationErrorResponse, readJson } from "@/lib/floor-api";
import { pokeSessionRouter } from "@/lib/router-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { parseConflictAnswersInput } from "@/lib/validation";

export async function POST(request: Request, { params }: { params: Promise<{ id: string; caseId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const input = parseConflictAnswersInput(await readJson(request));
  if (!input) return Response.json({ error: "Submit one non-empty answer for every current question." }, { status: 400 });
  const { id: sessionId, caseId } = await params;
  try {
    const result = await answerConflictQuestions(sessionId, caseId, user.id, input.answers);
    if (result === "missing") return Response.json({ error: "Session not found" }, { status: 404 });
    if (result === "stale") return Response.json({ error: "These conflict questions were already answered or replaced." }, { status: 409 });
    await pokeSessionRouter(sessionId, "toggle");
    const floor = await getFloorSnapshot(sessionId, user.id);
    if (!floor) return Response.json({ error: "Session not found" }, { status: 404 });
    return floorMutationResponse(sessionId, floor, ["queue", "runs", "review"], 202);
  } catch (error) {
    return mutationErrorResponse(error);
  }
}
