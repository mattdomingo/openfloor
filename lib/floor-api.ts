import type { FloorDomain, FloorSnapshot } from "./floor-types";
import { notifyFloorChanged } from "./presence-server";

export async function readJson(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
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
