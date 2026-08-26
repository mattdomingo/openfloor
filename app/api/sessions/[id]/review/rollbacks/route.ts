import { getFloorSnapshot } from "@/db/floor";
import { startAgentRunRollbackGroup } from "@/lib/agent-run-rollback";
import { readJson } from "@/lib/floor-api";
import type { AgentRunRollbackScope } from "@/lib/floor-types";
import { notifyFloorChanged } from "@/lib/presence-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";

const SCOPES = new Set<AgentRunRollbackScope>(["prompt", "engineer", "agent"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 256_000;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id } = await params;
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return Response.json({ error: "Rollback request is too large" }, { status: 413 });
  }
  const body = await readJson(request) as Record<string, unknown> | null;
  const scope = body?.scope as AgentRunRollbackScope | undefined;
  const subjectId = typeof body?.subjectId === "string" ? body.subjectId.trim() : "";
  const expectedCandidateSha = typeof body?.expectedCandidateSha === "string" ? body.expectedCandidateSha.trim() : "";
  const expectedRunIds = Array.isArray(body?.expectedRunIds) && body.expectedRunIds.every((value) => typeof value === "string")
    ? [...new Set(body.expectedRunIds as string[])]
    : null;
  if (!scope || !SCOPES.has(scope) || !UUID_PATTERN.test(subjectId) || !/^[0-9a-f]{40}$/.test(expectedCandidateSha) ||
      !expectedRunIds?.length || expectedRunIds.some((runId) => !UUID_PATTERN.test(runId))) {
    return Response.json({ error: "Invalid rollback request" }, { status: 400 });
  }
  let result;
  try {
    result = await startAgentRunRollbackGroup(id, user.id, { scope, subjectId, expectedCandidateSha, expectedRunIds });
  } catch {
    return Response.json({ error: "Rollback could not be started" }, { status: 502 });
  }
  if (!result.ok) {
    return Response.json({ error: result.message }, { status: result.kind === "not_ready" && result.message === "Session not found" ? 404 : 409 });
  }
  const floor = await getFloorSnapshot(id, user.id);
  if (!floor) return Response.json({ error: "Session not found" }, { status: 404 });
  await notifyFloorChanged(id, floor.revision, ["repository", "queue", "runs", "review"]);
  return Response.json({ floor }, { status: 202 });
}
