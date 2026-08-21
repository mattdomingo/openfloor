import { env } from "cloudflare:workers";
import type { FloorDomain, RunActivityEvent } from "./floor-types";

type DurableObjectStubLike = { fetch(request: Request | string, init?: RequestInit): Promise<Response> };
type DurableObjectNamespaceLike = {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
};

function presenceStub(sessionId: string): DurableObjectStubLike | null {
  const namespace = (env as unknown as { SESSION_PRESENCE?: DurableObjectNamespaceLike }).SESSION_PRESENCE;
  if (!namespace) return null;
  return namespace.get(namespace.idFromName(sessionId));
}

export async function notifyMembersChanged(sessionId: string): Promise<void> {
  await presenceStub(sessionId)?.fetch("https://presence.internal/members-changed", { method: "POST" });
}

export async function notifySessionChanged(
  sessionId: string,
  change: { objective: string | null; updatedAt: number },
): Promise<void> {
  await presenceStub(sessionId)?.fetch("https://presence.internal/session-changed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(change),
  });
}

export async function notifyFloorChanged(sessionId: string, revision: number, domains: FloorDomain[]): Promise<void> {
  await presenceStub(sessionId)?.fetch("https://presence.internal/floor-changed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision, domains }),
  });
}

export async function notifyRunActivity(
  sessionId: string,
  payload: { runId: string; agentId: string; events: RunActivityEvent[] },
): Promise<void> {
  await presenceStub(sessionId)?.fetch("https://presence.internal/run-activity", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function notifySessionEnded(sessionId: string, endedAt: number, reason: "owner" | "merged"): Promise<void> {
  await presenceStub(sessionId)?.fetch("https://presence.internal/session-ended", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endedAt, reason }),
  });
}

export async function disconnectPresenceUser(sessionId: string, userId: string, reason?: "removed"): Promise<void> {
  await presenceStub(sessionId)?.fetch("https://presence.internal/disconnect-user", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId, reason }),
  });
}

export async function notifySessionLocked(sessionId: string, lockedAt: number | null): Promise<void> {
  await presenceStub(sessionId)?.fetch("https://presence.internal/session-locked", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lockedAt }),
  });
}
