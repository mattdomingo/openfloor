import { ConflictSnapshotError } from "./conflict-resolution";
import { FloorConflictError, FloorTargetError } from "@/db/floor";
import { getActiveMembershipRole, getOwnerHourQuota, SessionEndedError, SessionRoutingError } from "@/db/sessions";
import { getDb } from "@/db";
import type { FloorDomain, FloorSnapshot } from "./floor-types";
import { notifyFloorChanged } from "./presence-server";

export async function readJson(request: Request, maxBytes?: number): Promise<unknown | null> {
  try {
    if (maxBytes === undefined) return await request.json();
    if (!request.body || Number(request.headers.get("content-length") ?? 0) > maxBytes) return null;
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return null;
  }
}

/* Shared catch for session-scoped mutations: typed domain errors become
   client responses, anything else keeps propagating. SessionEndedError maps
   to 409 rather than 404 because 404 means "kicked from the session" to
   usePersistentFloorData. */
export function mutationErrorResponse(error: unknown): Response {
  if (error instanceof ConflictSnapshotError) return Response.json({ error: error.message }, { status: 503 });
  if (error instanceof SessionEndedError) return Response.json({ error: error.message }, { status: 409 });
  if (error instanceof FloorConflictError) return Response.json({ error: error.message }, { status: 409 });
  if (error instanceof FloorTargetError) return Response.json({ error: error.message }, { status: 400 });
  if (error instanceof SessionRoutingError) return Response.json({ error: error.message }, { status: 400 });
  throw error;
}

export async function activeOwnerErrorResponse(sessionId: string, userId: string): Promise<Response | null> {
  try {
    return (await getActiveMembershipRole(sessionId, userId)) === "owner"
      ? null
      : Response.json({ error: "Session not found" }, { status: 404 });
  } catch (error) {
    return mutationErrorResponse(error);
  }
}

/* Gate for the spend-initiating repository operations (preflight, sync) —
   both burn real sandbox/GitHub-API time. Call after activeOwnerErrorResponse
   has already confirmed the session exists and the caller is its active
   owner, which is why (unlike lib/agent-run-start.ts's use of the same
   getOwnerHourQuota) a null quota here is treated as an invariant violation
   and fails closed rather than silently allowing the operation through. */
export async function quotaExhaustedErrorResponse(sessionId: string): Promise<Response | null> {
  const quota = await getOwnerHourQuota(sessionId, getDb());
  if (!quota) throw new Error(`getOwnerHourQuota returned no row for session ${sessionId}`);
  if (quota.endedAt != null) return null;
  if (quota.seconds < quota.limitHours * 3600) return null;
  if (quota.limitHours === 0) {
    return Response.json(
      { error: "This email already used its free openfloor hours. Choose a plan to continue.", code: "free_allowance_used" },
      { status: 403 },
    );
  }
  return Response.json(
    { error: "Your plan's monthly session hours are used up.", code: "quota_exhausted" },
    { status: 403 },
  );
}

export async function floorMutationResponse(
  sessionId: string,
  floor: FloorSnapshot,
  domains: FloorDomain[],
  status = 200,
) {
  await notifyFloorChanged(sessionId, floor.revision, domains);
  return Response.json({ floor }, { status });
}
