import { FloorConflictError, FloorTargetError } from "@/db/floor";
import { getActiveMembershipRole, SessionEndedError } from "@/db/sessions";
import type { FloorDomain, FloorSnapshot } from "./floor-types";
import { notifyFloorChanged } from "./presence-server";

export async function readJson(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/* Shared catch for session-scoped mutations: typed domain errors become
   client responses, anything else keeps propagating. SessionEndedError maps
   to 409 rather than 404 because 404 means "kicked from the session" to
   usePersistentFloorData. */
export function mutationErrorResponse(error: unknown): Response {
  if (error instanceof SessionEndedError) return Response.json({ error: error.message }, { status: 409 });
  if (error instanceof FloorConflictError) return Response.json({ error: error.message }, { status: 409 });
  if (error instanceof FloorTargetError) return Response.json({ error: error.message }, { status: 400 });
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

export async function floorMutationResponse(
  sessionId: string,
  floor: FloorSnapshot,
  domains: FloorDomain[],
  status = 200,
) {
  await notifyFloorChanged(sessionId, floor.revision, domains);
  return Response.json({ floor }, { status });
}
