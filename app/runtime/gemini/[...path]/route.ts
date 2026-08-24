import { getRunAgentOwnerCredential } from "@/db/provider-credentials";
import { getRunGatewayContext } from "@/db/runs";
import { decryptCredential } from "@/lib/credential-crypto";
import { resolveRunCredentialSource } from "@/lib/provider-credentials";
import { verifyRunGatewayToken } from "@/lib/runtime-token";
import { env } from "cloudflare:workers";

// Deliberately NOT on lib/anthropic-compat-gateway.ts — the divergence is
// structural, not cosmetic: the run JWT arrives in `x-goog-api-key` (the
// header the Gemini CLI sends its key in), the path check is a pattern over
// `models/<model>:<verb>` rather than a Set, and the query string must be
// forwarded (filtered) because `?alt=sse` is how the CLI gets streaming —
// the Anthropic-compat handler drops query strings entirely.

const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
// Start from the Spike-C-observed traffic (`v1beta/models/<model>:
// streamGenerateContent?alt=sse`), plus the non-streaming and token-count
// verbs the same surface serves; log-then-404 everything else so the pattern
// is finalized from observed traffic, exactly like the other gateways.
const ALLOWED_PATH_PATTERN = /^(v1beta|v1)\/models\/[\w.-]+:(generateContent|streamGenerateContent|countTokens)$/;
// The CLI's streaming switch; every other query parameter is dropped.
const ALLOWED_QUERY_PARAMS = new Set(["alt"]);

export async function POST(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const bindings = env as unknown as { RUNTIME_GATEWAY_SECRET?: string; GEMINI_API_KEY?: string; CREDENTIAL_ENCRYPTION_KEY?: string };
  const token = request.headers.get("x-goog-api-key")
    ?? request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (!token || !bindings.RUNTIME_GATEWAY_SECRET) return new Response("Not found", { status: 404 });
  const claims = await verifyRunGatewayToken(token, bindings.RUNTIME_GATEWAY_SECRET, "gemini");
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
  const path = (await params).path.join("/");
  if (!ALLOWED_PATH_PATTERN.test(path)) {
    console.warn(`gemini gateway rejected path: POST /${path}`);
    return new Response("Not found", { status: 404 });
  }
  const requestUrl = new URL(request.url);
  const query = new URLSearchParams();
  for (const name of ALLOWED_QUERY_PARAMS) {
    const value = requestUrl.searchParams.get(name);
    if (value !== null) query.set(name, value);
  }
  // Same resolution order as every other gateway: the agent owner's connected
  // key, else the server key, else refuse — a present-but-unreadable owner
  // credential refuses rather than switching payer.
  const ownerCredential = await getRunAgentOwnerCredential(claims.runId, "gemini");
  const resolution = resolveRunCredentialSource({
    ownerCredentialPresent: Boolean(ownerCredential),
    serverKeyPresent: Boolean(bindings.GEMINI_API_KEY),
  });
  let apiKey: string;
  if (resolution.source === "owner") {
    const decrypted = ownerCredential && bindings.CREDENTIAL_ENCRYPTION_KEY
      ? await decryptCredential(ownerCredential.ciphertext, bindings.CREDENTIAL_ENCRYPTION_KEY, `${ownerCredential.ownerUserId}:gemini`)
      : null;
    if (!decrypted) {
      return new Response("The agent owner's connected Google key could not be read. Reconnect it in Settings.", { status: 503 });
    }
    apiKey = decrypted;
  } else if (resolution.source === "server" && bindings.GEMINI_API_KEY) {
    apiKey = bindings.GEMINI_API_KEY;
  } else {
    return new Response("No Google credential is available for this run.", { status: 503 });
  }
  const headers = new Headers();
  headers.set("x-goog-api-key", apiKey);
  headers.set("content-type", request.headers.get("content-type") ?? "application/json");
  headers.set("accept", request.headers.get("accept") ?? "application/json");
  const upstream = await fetch(
    `https://generativelanguage.googleapis.com/${path}${query.size > 0 ? `?${query}` : ""}`,
    { method: "POST", headers, body },
  );
  const responseHeaders = new Headers();
  for (const name of ["content-type", "cache-control"]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  responseHeaders.set("x-content-type-options", "nosniff");
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

// The CLI probes GET endpoints depending on configuration; none are needed
// for a run. Log so the pattern can be finalized from observed traffic, and
// conceal like every other miss.
export async function GET(_request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  console.warn(`gemini gateway rejected path: GET /${(await params).path.join("/")}`);
  return new Response("Not found", { status: 404 });
}
