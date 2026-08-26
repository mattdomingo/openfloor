import { resolveRunProviderSecret } from "@/db/provider-credentials";
import { getRunGatewayContext } from "@/db/runs";
import { verifyRunGatewayToken } from "@/lib/runtime-token";
import { env } from "cloudflare:workers";

const MAX_REQUEST_BYTES = 10 * 1024 * 1024;

export async function POST(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const bindings = env as unknown as { RUNTIME_GATEWAY_SECRET?: string; OPENAI_API_KEY?: string; CREDENTIAL_ENCRYPTION_KEY?: string };
  const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (!token || !bindings.RUNTIME_GATEWAY_SECRET) return new Response("Not found", { status: 404 });
  const claims = await verifyRunGatewayToken(token, bindings.RUNTIME_GATEWAY_SECRET, "openai");
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
  const normalized = parts[0] === "v1" ? parts.slice(1) : parts;
  if (normalized.length !== 1 || normalized[0] !== "responses") return new Response("Not found", { status: 404 });
  // The shared ladder (db/provider-credentials.ts): the agent owner's
  // connected credential of the kind the agent names, else the server key,
  // else refuse. A present-but-unreadable owner credential and a named-but-
  // unconnected kind both refuse rather than silently billing another payer.
  const resolved = await resolveRunProviderSecret(claims.runId, "openai", {
    serverKey: bindings.OPENAI_API_KEY,
    encryptionKey: bindings.CREDENTIAL_ENCRYPTION_KEY,
  });
  if (!resolved.ok) return new Response(resolved.message, { status: 503 });
  // A ChatGPT-subscription auth bundle cannot drive a Codex run until the
  // brief's §5 ships (gated on Spike D, which has not run). Refuse before
  // any header is built: sending the stored bundle — refresh token included
  // — upstream as a bearer would be a credential leak, and a pretty-printed
  // bundle's newlines would crash Headers.set into an opaque 500 besides.
  if (resolved.kind === "oauth") {
    return new Response(
      "ChatGPT subscription credentials cannot run agents yet. Set this agent's Billing to API key, or connect an OpenAI API key in Settings.",
      { status: 503 },
    );
  }
  const headers = new Headers();
  headers.set("authorization", `Bearer ${resolved.secret}`);
  headers.set("content-type", request.headers.get("content-type") ?? "application/json");
  headers.set("accept", request.headers.get("accept") ?? "application/json");
  const beta = request.headers.get("openai-beta");
  if (beta) headers.set("openai-beta", beta);
  const upstream = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers, body });
  const responseHeaders = new Headers();
  for (const name of ["content-type", "cache-control", "openai-processing-ms", "x-request-id"]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  responseHeaders.set("x-content-type-options", "nosniff");
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}
