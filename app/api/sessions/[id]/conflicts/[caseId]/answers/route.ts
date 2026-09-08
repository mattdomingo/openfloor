import { proposeConflictResolution } from "@/db/conflict-decisions";
import { getFloorSnapshot } from "@/db/floor";
import { floorMutationResponse, mutationErrorResponse, readJson } from "@/lib/floor-api";
import { pokeSessionRouter } from "@/lib/router-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { parseConflictProposalInput } from "@/lib/validation";
import { readSnapshotManifest } from "@/lib/conflict-snapshot-server";

export async function POST(request: Request, { params }: { params: Promise<{ id: string; caseId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id: sessionId, caseId } = await params;
  try {
    const snapshot = await readSnapshotManifest(sessionId, caseId, user.id);
    if (!snapshot) return Response.json({ error: "Session not found" }, { status: 404 });
    const input = parseConflictProposalInput(await readJson(request, 12_000_000));
    if (!input) return Response.json({ error: "Refresh the conflict and submit a versioned proposal.", code: "stale_conflict" }, { status: 409 });
    if (input.payload.kind !== "intent") return Response.json({ error: "Invalid proposal kind." }, { status: 400 });
    if (snapshot.pending || input.snapshotId !== snapshot.id || input.revision !== snapshot.revision) return Response.json({ error: "Conflict versions changed. Refresh and review again.", code: "stale_conflict" }, { status: 409 });
    const result = await proposeConflictResolution({ sessionId, caseId, userId: user.id, ...input });
    if (result === "missing") return Response.json({ error: "Session not found" }, { status: 404 });
    if (result === "stale") return Response.json({ error: "Conflict versions changed. Refresh and review again.", code: "stale_conflict" }, { status: 409 });
    await pokeSessionRouter(sessionId, "toggle");
    const floor = await getFloorSnapshot(sessionId, user.id);
    if (!floor) return Response.json({ error: "Session not found" }, { status: 404 });
    return floorMutationResponse(sessionId, floor, ["queue", "runs", "review"], 202);
  } catch (error) {
    return mutationErrorResponse(error);
  }
}
