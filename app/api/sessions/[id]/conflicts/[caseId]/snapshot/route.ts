import { getConflictSnapshotArtifact } from "@/db/conflicts";
import { buildConflictFileSnapshot, type ConflictSnapshotFileRaw } from "@/lib/conflict-hunks";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { env } from "cloudflare:workers";

type R2ObjectLike = { text(): Promise<string> };
type R2BucketLike = { get(key: string): Promise<R2ObjectLike | null> };

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; caseId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id: sessionId, caseId } = await params;
  const access = await getConflictSnapshotArtifact(sessionId, caseId, user.id);
  if (access === "forbidden") return Response.json({ error: "Session not found" }, { status: 404 });
  if (access === "not_found") return Response.json({ error: "No conflict snapshot is available for this case yet." }, { status: 404 });
  const bucket = (env as unknown as { PREFLIGHT_LOGS?: R2BucketLike }).PREFLIGHT_LOGS;
  if (!bucket) return Response.json({ error: "Conflict snapshots are unavailable" }, { status: 503 });
  const object = await bucket.get(access.r2Key);
  if (!object) return Response.json({ error: "No conflict snapshot is available for this case yet." }, { status: 404 });
  let raw: { files: ConflictSnapshotFileRaw[] };
  try {
    raw = JSON.parse(await object.text());
  } catch {
    return Response.json({ error: "The stored conflict snapshot is corrupted." }, { status: 500 });
  }
  const rawPaths = new Set(raw.files.map((file) => file.path));
  const files = raw.files.map((file) => buildConflictFileSnapshot(file));
  const omittedPaths = access.conflictPaths.filter((path) => !rawPaths.has(path));
  return Response.json({
    snapshot: { snapshotRunId: access.runId, files, omittedPaths, existingSelections: access.existingSelections },
  }, { headers: { "cache-control": "no-store" } });
}
