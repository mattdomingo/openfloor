import { voteConflictProposal } from "@/db/conflict-decisions";
import { getFloorSnapshot } from "@/db/floor";
import { floorMutationResponse, mutationErrorResponse, readJson } from "@/lib/floor-api";
import { pokeSessionRouter } from "@/lib/router-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { parseConflictVoteInput } from "@/lib/validation";

export async function POST(request: Request, { params }: { params: Promise<{ id: string; caseId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id: sessionId, caseId } = await params;
  const input = parseConflictVoteInput(await readJson(request, 12_000_000));
  if (!input) return Response.json({ error: "Provide the proposal, current revision, and decision. Owner overrides require a reason." }, { status: 400 });
  try {
    const result = await voteConflictProposal({ ...input, sessionId, caseId, userId: user.id });
    if (result === "missing") return Response.json({ error: "Session not found" }, { status: 404 });
    if (result === "stale") return Response.json({ error: "This proposal changed. Refresh before deciding.", code: "stale_conflict" }, { status: 409 });
    await pokeSessionRouter(sessionId, "toggle");
    const floor = await getFloorSnapshot(sessionId, user.id);
    if (!floor) return Response.json({ error: "Session not found" }, { status: 404 });
    return floorMutationResponse(sessionId, floor, ["queue", "runs", "review"], 202);
  } catch (error) { return mutationErrorResponse(error); }
}
