import { env } from "cloudflare:workers";
import type { RoutingTrigger } from "@/db/routing";

type DurableObjectStubLike = { fetch(request: Request | string, init?: RequestInit): Promise<Response> };
type DurableObjectNamespaceLike = {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
};

function routerStub(sessionId: string): DurableObjectStubLike | null {
  const namespace = (env as unknown as { SESSION_ROUTER?: DurableObjectNamespaceLike }).SESSION_ROUTER;
  if (!namespace) return null;
  return namespace.get(namespace.idFromName(sessionId));
}

export async function pokeSessionRouter(sessionId: string, trigger: RoutingTrigger): Promise<void> {
  try {
    await routerStub(sessionId)?.fetch("https://router.internal/poke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, trigger }),
    });
  } catch {
    // Best-effort: the alarm fallback and later pokes cover a missed wake.
  }
}
