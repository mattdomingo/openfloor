import { resolveRunProviderSecret } from "@/db/provider-credentials";
import { getRunGatewayContext } from "@/db/runs";
import { type CredentialProvider } from "@/lib/provider-credentials";
import { verifyRunGatewayToken, type RunGatewayClaims } from "@/lib/runtime-token";
import { env } from "cloudflare:workers";

// One handler for every Anthropic-Messages-compatible model gateway
// (/runtime/anthropic, /runtime/kimi): run-scoped JWT bound to the provider's
// operation, run-status check, size cap, path allowlist grown from logged
// rejections, owner-key-else-server-key-else-refuse, upstream fetch with SSE
// passthrough. Extracted (rather than copied per provider) because the route
// is security-sensitive and every future fix would otherwise land N times;
// if a vendor ever needs divergent behavior (e.g. response rewriting), fall
// back to a standalone route for it and say so in the commit.

const MAX_REQUEST_BYTES = 10 * 1024 * 1024;

export type AnthropicCompatGatewayConfig = {
  operation: RunGatewayClaims["operation"];
  provider: CredentialProvider;
  // Upstream prefix the normalized path is appended to, e.g.
  // "https://api.anthropic.com/v1" or "https://api.moonshot.ai/anthropic/v1".
  upstreamBase: string;
  // Worker secret binding name for the server-side fallback key. Bindings are
  // read by name here because gateways cast env inline by convention
  // (cloudflare-env.d.ts deliberately doesn't declare provider keys).
  serverKeyBinding: string;
  buildAuthHeaders: (apiKey: string) => Record<string, string>;
  allowedPaths: ReadonlySet<string>;
};

export async function handleAnthropicCompatProxy(
  request: Request,
  params: Promise<{ path: string[] }>,
  config: AnthropicCompatGatewayConfig,
): Promise<Response> {
  const bindings = env as unknown as Record<string, string | undefined>;
  const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (!token || !bindings.RUNTIME_GATEWAY_SECRET) return new Response("Not found", { status: 404 });
  const claims = await verifyRunGatewayToken(token, bindings.RUNTIME_GATEWAY_SECRET, config.operation);
  if (!claims) return new Response("Not found", { status: 404 });
  const context = await getRunGatewayContext(claims.runId);
  if (
    !context || context.sessionId !== claims.sessionId || context.repositoryId !== claims.repositoryId
    || context.candidateSha !== claims.candidateSha || !["running", "cancel_requested"].includes(context.status)
  ) return new Response("Not found", { status: 404 });
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_REQUEST_BYTES) return new Response("Payload too large", { status: 413 });
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_REQUEST_BYTES) return new Response("Payload too large", { status: 413 });
  const parts = (await params).path;
  const normalized = (parts[0] === "v1" ? parts.slice(1) : parts).join("/");
  if (!config.allowedPaths.has(normalized)) {
    console.warn(`${config.provider} gateway rejected path: POST /${parts.join("/")}`);
    return new Response("Not found", { status: 404 });
  }
  // The shared ladder (db/provider-credentials.ts): the agent owner's
  // connected credential of the kind the agent names, else the server key,
  // else refuse — a present-but-unreadable owner credential and a named-but-
  // unconnected kind both refuse rather than switching payer.
  const resolved = await resolveRunProviderSecret(claims.runId, config.provider, {
    serverKey: bindings[config.serverKeyBinding],
    encryptionKey: bindings.CREDENTIAL_ENCRYPTION_KEY,
  });
  if (!resolved.ok) return new Response(resolved.message, { status: 503 });
  const headers = new Headers();
  for (const [name, value] of Object.entries(config.buildAuthHeaders(resolved.secret))) headers.set(name, value);
  headers.set("anthropic-version", request.headers.get("anthropic-version") ?? "2023-06-01");
  headers.set("content-type", request.headers.get("content-type") ?? "application/json");
  headers.set("accept", request.headers.get("accept") ?? "application/json");
  const beta = request.headers.get("anthropic-beta");
  if (beta) headers.set("anthropic-beta", beta);
  const upstream = await fetch(`${config.upstreamBase}/${normalized}`, { method: "POST", headers, body });
  const responseHeaders = new Headers();
  for (const name of ["content-type", "cache-control", "request-id", "anthropic-ratelimit-requests-remaining"]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  responseHeaders.set("x-content-type-options", "nosniff");
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

// The CLI probes a few GET endpoints (e.g. /v1/models) depending on
// configuration. They are not needed for a run; log them so allowlists can be
// finalized from observed traffic, and conceal like every other miss.
export async function logAndConcealGet(provider: CredentialProvider, params: Promise<{ path: string[] }>): Promise<Response> {
  console.warn(`${provider} gateway rejected path: GET /${(await params).path.join("/")}`);
  return new Response("Not found", { status: 404 });
}
