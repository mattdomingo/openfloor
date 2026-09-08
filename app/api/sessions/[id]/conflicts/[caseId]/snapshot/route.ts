import { getConflictDecisionView, conflictAccess, refreshConflictSnapshot } from "@/db/conflict-decisions";
import { getDb } from "@/db";
import { getFloorSnapshot } from "@/db/floor";
import { readSnapshotManifest, readSnapshotFile } from "@/lib/conflict-snapshot-server";
import { parseConflictHunks } from "@/lib/conflict-hunks";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { floorMutationResponse, mutationErrorResponse, readJson } from "@/lib/floor-api";
import { pokeSessionRouter } from "@/lib/router-server";

export async function GET(request: Request, { params }: { params: Promise<{ id: string; caseId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id: sessionId, caseId } = await params;
  try {
    const snapshot = await readSnapshotManifest(sessionId, caseId, user.id);
    if (!snapshot) return Response.json({ error: "Session not found" }, { status: 404 });
    if (snapshot.pending) return Response.json({ error: "Conflict versions are being prepared. Refresh if preparation stopped.", code: "snapshot_pending" }, { status: 409 });
    const view = await getConflictDecisionView(sessionId, caseId, user.id);
    const url = new URL(request.url);
    const index = url.searchParams.get("file");
    let detail = null;
    if (index !== null) {
      const entry = /^\d+$/.test(index) ? snapshot.manifest.files[Number(index)] : null;
      const after = Number(url.searchParams.get("after") ?? "0");
      if (!entry || !Number.isSafeInteger(after) || after < 0) return Response.json({ error: "Invalid file or page." }, { status: 400 });
      const file = await readSnapshotFile(snapshot.manifestKey, entry);
      const hunks = !entry.wholeFileOnly && file.merged !== null ? parseConflictHunks(file.merged) : [];
      detail = { path: file.path, fingerprint: file.fingerprint, kind: file.kind, wholeFileOnly: file.wholeFileOnly,
        ours: file.ours?.slice(0, 16_384) ?? null, theirs: file.theirs?.slice(0, 16_384) ?? null,
        oursDeleted: file.stages[1] === null, theirsDeleted: file.stages[2] === null,
        hunks: hunks.slice(after, after + 20), totalHunks: hunks.length, nextAfter: after + 20 < hunks.length ? after + 20 : null,
        ...(url.searchParams.get("format") === "text" && entry.canEdit ? { result: file.merged } : {}),
      };
    }
    return Response.json({ snapshot: { id: snapshot.id, revision: snapshot.revision, candidateSha: snapshot.candidateSha,
      sourceRunId: snapshot.sourceRunId, sourceCommitSha: snapshot.sourceCommitSha, files: snapshot.manifest.files, detail,
      canPropose: view?.canPropose ?? false, canOverride: view?.canOverride ?? false } }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Snapshot could not be loaded." }, { status: 503 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string; caseId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id: sessionId, caseId } = await params;
  try {
    if (!await conflictAccess(sessionId, caseId, user.id, true, getDb())) return Response.json({ error: "Session not found" }, { status: 404 });
    const input = await readJson(request, 12_000_000) as { revision?: number } | null;
    const view = await getConflictDecisionView(sessionId, caseId, user.id);
    if (!view?.canPropose && !view?.canOverride) return Response.json({ error: "Session not found" }, { status: 404 });
    if (input?.revision !== view.resolution.revision) return Response.json({ error: "Conflict changed. Reload first.", code: "stale_conflict" }, { status: 409 });
    if (!await refreshConflictSnapshot(sessionId, caseId, null, getDb(), input.revision)) return Response.json({ error: "Conflict work is already active." }, { status: 409 });
    await pokeSessionRouter(sessionId, "toggle");
    const floor = await getFloorSnapshot(sessionId, user.id);
    if (!floor) return Response.json({ error: "Session not found" }, { status: 404 });
    return floorMutationResponse(sessionId, floor, ["queue", "runs", "review"], 202);
  } catch (error) { return mutationErrorResponse(error); }
}
