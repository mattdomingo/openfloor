import { env } from "cloudflare:workers";

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

export async function disconnectPresenceUser(sessionId: string, userId: string): Promise<void> {
  await presenceStub(sessionId)?.fetch("https://presence.internal/disconnect-user", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  });
}
