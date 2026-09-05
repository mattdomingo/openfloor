import { getFloorSnapshot } from "@/db/floor";
import { startCandidateFileRemoval } from "@/lib/candidate-file-removal";
import { readJson } from "@/lib/floor-api";
import { notifyFloorChanged } from "@/lib/presence-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { parseCandidateFileRemovalInput } from "@/lib/validation";

const MAX_BODY_BYTES = 8_192;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id } = await params;
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return Response.json({ error: "File removal request is too large" }, { status: 413 });
  }
  const input = parseCandidateFileRemovalInput(await readJson(request));
  if (!input) return Response.json({ error: "Invalid file removal request" }, { status: 400 });
  let result;
  try {
    result = await startCandidateFileRemoval(id, user.id, input);
  } catch {
    return Response.json({ error: "File removal could not be started" }, { status: 502 });
  }
  if (!result.ok) {
    return Response.json({ error: result.message }, { status: result.kind === "not_ready" ? 404 : 409 });
  }
  const floor = await getFloorSnapshot(id, user.id);
  if (!floor) return Response.json({ error: "Session not found" }, { status: 404 });
  await notifyFloorChanged(id, floor.revision, ["repository", "review"]);
  return Response.json({ floor }, { status: 202 });
}
