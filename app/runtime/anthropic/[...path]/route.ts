import { getSessionOwnerCredential } from "@/db/provider-credentials";
import { getRunGatewayContext } from "@/db/runs";
import { decryptCredential } from "@/lib/credential-crypto";
import { verifyRunGatewayToken } from "@/lib/runtime-token";
import { env } from "cloudflare:workers";

const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
// Finalized from observed traffic during the rollout spike — rejected paths
// are logged below specifically so this list is grown from evidence, not spec.
const ALLOWED_PATHS = new Set(["messages", "messages/count_tokens"]);

export async function POST(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const bindings = env as unknown as { RUNTIME_GATEWAY_SECRET?: string; ANTHROPIC_API_KEY?: string; CREDENTIAL_ENCRYPTION_KEY?: string };
  const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (!token || !bindings.RUNTIME_GATEWAY_SECRET) return new Response("Not found", { status: 404 });
  const claims = await verifyRunGatewayToken(token, bindings.RUNTIME_GATEWAY_SECRET, "anthropic");
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
  if (!ALLOWED_PATHS.has(normalized)) {
    console.warn(`anthropic gateway rejected path: POST /${parts.join("/")}`);
    return new Response("Not found", { status: 404 });
  }
  // Same resolution order as the OpenAI gateway (lib/provider-credentials.ts):
  // session owner's connected key, else the server key, else refuse — and a
  // present-but-unreadable owner credential refuses rather than switching payer.
  const ownerCredential = await getSessionOwnerCredential(claims.sessionId, "anthropic");
  let apiKey: string;
  if (ownerCredential) {
    const decrypted = bindings.CREDENTIAL_ENCRYPTION_KEY
      ? await decryptCredential(ownerCredential.ciphertext, bindings.CREDENTIAL_ENCRYPTION_KEY, `${ownerCredential.ownerUserId}:anthropic`)
      : null;
    if (!decrypted) {
      return new Response("The session owner's connected Anthropic key could not be read. Reconnect it in Settings.", { status: 503 });
    }
    apiKey = decrypted;
  } else if (bindings.ANTHROPIC_API_KEY) {
    apiKey = bindings.ANTHROPIC_API_KEY;
  } else {
    return new Response("No Anthropic credential is available for this run.", { status: 503 });
  }
  const headers = new Headers();
  headers.set("x-api-key", apiKey);
  headers.set("anthropic-version", request.headers.get("anthropic-version") ?? "2023-06-01");
  headers.set("content-type", request.headers.get("content-type") ?? "application/json");
  headers.set("accept", request.headers.get("accept") ?? "application/json");
  const beta = request.headers.get("anthropic-beta");
  if (beta) headers.set("anthropic-beta", beta);
  const upstream = await fetch(`https://api.anthropic.com/v1/${normalized}`, { method: "POST", headers, body });
  const responseHeaders = new Headers();
  for (const name of ["content-type", "cache-control", "request-id", "anthropic-ratelimit-requests-remaining"]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  responseHeaders.set("x-content-type-options", "nosniff");
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

// The CLI probes a few GET endpoints (e.g. /v1/models) depending on
// configuration. They are not needed for a run; log them so the allowlist can
// be finalized from observed traffic, and conceal like every other miss.
export async function GET(_request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  console.warn(`anthropic gateway rejected path: GET /${(await params).path.join("/")}`);
  return new Response("Not found", { status: 404 });
}
