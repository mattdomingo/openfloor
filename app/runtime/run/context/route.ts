import { renderRunBrief } from "@/db/session-context";
import { verifyRunGatewayToken } from "@/lib/runtime-token";
import { env } from "cloudflare:workers";

// Live re-read for the openfloor MCP tool a dispatched agent can call
// mid-run. Unlike /runtime/run/events (called every few seconds for up to an
// hour), this is invoked only when the agent deliberately re-reads the
// floor, so a fuller run + session read per call is the right tradeoff.
export async function GET(request: Request) {
  const bindings = env as unknown as { RUNTIME_GATEWAY_SECRET?: string };
  const token = bearer(request);
  if (!token || !bindings.RUNTIME_GATEWAY_SECRET) return new Response("Not found", { status: 404 });
  const claims = await verifyRunGatewayToken(token, bindings.RUNTIME_GATEWAY_SECRET, "context");
  if (!claims) return new Response("Not found", { status: 404 });
  const brief = await renderRunBrief(claims.runId);
  if (!brief || !matches(brief, claims) || !["running", "cancel_requested"].includes(brief.status)) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(brief.text, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

function bearer(request: Request) {
  return request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1] ?? null;
}

function matches(brief: { sessionId: string; repositoryId: string; candidateSha: string }, claims: { sessionId: string; repositoryId: string; candidateSha: string }) {
  return brief.sessionId === claims.sessionId && brief.repositoryId === claims.repositoryId && brief.candidateSha === claims.candidateSha;
}
