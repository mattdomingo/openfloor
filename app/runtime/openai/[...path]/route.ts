import { ensureFreshChatGptBundle, resolveRunProviderSecret } from "@/db/provider-credentials";
import { getRunGatewayContext } from "@/db/runs";
import { CHATGPT_RESPONSES_URL } from "@/lib/chatgpt-auth";
import { verifyRunGatewayToken } from "@/lib/runtime-token";
import { env } from "cloudflare:workers";

const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

export async function POST(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const bindings = env as unknown as { RUNTIME_GATEWAY_SECRET?: string; OPENAI_API_KEY?: string; CREDENTIAL_ENCRYPTION_KEY?: string };
  const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (!token || !bindings.RUNTIME_GATEWAY_SECRET) return new Response("Not found", { status: 404 });
  const claims = await verifyRunGatewayToken(token, bindings.RUNTIME_GATEWAY_SECRET, "openai");
  if (!claims) return new Response("Not found", { status: 404 });
  const context = await getRunGatewayContext(claims.runId);
  if (
    !context || context.sessionId !== claims.sessionId || context.repositoryId !== claims.repositoryId
    || context.candidateSha !== claims.candidateSha || context.status !== "running"
  ) return new Response("Not found", { status: 404 });
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_REQUEST_BYTES) return new Response("Payload too large", { status: 413 });
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_REQUEST_BYTES) return new Response("Payload too large", { status: 413 });
  const parts = (await params).path;
  const normalized = parts[0] === "v1" ? parts.slice(1) : parts;
  if (normalized.length !== 1 || normalized[0] !== "responses") {
    // Logged with its provider prefix so the allowlist grows from evidence, the
    // same discipline the anthropic-compat handler follows. `GET /v1/models` is
    // the only other path the CLI is known to call, and only in ChatGPT auth
    // mode, which openfloor does not use — the shipped posture never asks for
    // it, so it stays refused rather than widening this route with a GET
    // handler. If a future pin does call it, it degrades (non-fatal upstream)
    // and shows up here as a logged rejection, which is the intended signal.
    console.warn(`openai gateway rejected path: ${normalized.join("/")}`);
    return new Response("Not found", { status: 404 });
  }
  // The shared ladder (db/provider-credentials.ts): the agent owner's
  // connected credential of the kind the agent names, else the server key,
  // else refuse. A present-but-unreadable owner credential and a named-but-
  // unconnected kind both refuse rather than silently billing another payer.
  const resolved = await resolveRunProviderSecret(claims.runId, "openai", {
    encryptionKey: bindings.CREDENTIAL_ENCRYPTION_KEY,
  });
  if (!resolved.ok) return new Response(resolved.message, { status: 503 });

  const headers = new Headers();
  let upstreamUrl = OPENAI_RESPONSES_URL;
  if (resolved.kind === "oauth") {
    // A ChatGPT subscription. The run sent its own JWT; only this gateway sees
    // the real credential, and only the access token leaves — never the stored
    // bundle, and never the refresh token. (Sending the bundle itself would
    // both leak the refresh token and crash Headers.set on a pretty-printed
    // bundle's newlines.)
    const bundle = await ensureFreshChatGptBundle(resolved, { encryptionKey: bindings.CREDENTIAL_ENCRYPTION_KEY });
    if (!bundle) {
      return new Response(
        "The agent owner's connected ChatGPT subscription could not be read. Reconnect it in Settings.",
        { status: 503 },
      );
    }
    // A subscription bearer authenticates only against the ChatGPT backend;
    // api.openai.com answers 401 for it (Spike D). The account header is the
    // gateway's to inject — the run has no bundle to read it from.
    upstreamUrl = CHATGPT_RESPONSES_URL;
    headers.set("authorization", `Bearer ${bundle.accessToken}`);
    headers.set("chatgpt-account-id", bundle.accountId);
  } else {
    headers.set("authorization", `Bearer ${resolved.secret}`);
  }
  // This narrow allowlist is verified sufficient against the ChatGPT backend,
  // not merely assumed: a run driven through a proxy forwarding ONLY these
  // headers returned 200. The CLI's own `originator`, `session-id`,
  // `thread-id`, `version`, `user-agent` and `x-codex-*` headers are all
  // dropped and none is required — which is a small privacy win too, since
  // `x-codex-turn-metadata` carries the absolute workspace path and the
  // workspace's latest git commit hash.
  headers.set("content-type", request.headers.get("content-type") ?? "application/json");
  headers.set("accept", request.headers.get("accept") ?? "application/json");
  // The CLI compresses request bodies (content-encoding: zstd). The body is
  // forwarded as opaque bytes, so dropping this header would present compressed
  // bytes as plain JSON and earn an upstream 400 that looks unrelated to
  // anything openfloor did. The size cap above deliberately measures the
  // compressed bytes, which is what actually crosses the wire.
  const encoding = request.headers.get("content-encoding");
  if (encoding) headers.set("content-encoding", encoding);
  const beta = request.headers.get("openai-beta");
  if (beta) headers.set("openai-beta", beta);
  const upstream = await fetch(upstreamUrl, { method: "POST", headers, body });
  const responseHeaders = new Headers();
  for (const name of ["content-type", "cache-control", "openai-processing-ms", "x-request-id"]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  responseHeaders.set("x-content-type-options", "nosniff");
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}
