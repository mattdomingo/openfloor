import { resolveRunProviderSecret } from "@/db/provider-credentials";
import { getRunGatewayContext } from "@/db/runs";
import { type CredentialProvider } from "@/lib/provider-credentials";
import { verifyRunGatewayToken, type RunGatewayClaims } from "@/lib/runtime-token";
import { env } from "cloudflare:workers";

// One handler for every OpenAI-chat-completions-compatible model gateway
// (/runtime/qwen, /runtime/deepseek) — lib/anthropic-compat-gateway.ts's
// shape, cloned rather than parameterized further because the two wires
// differ in auth translation and header families: run-scoped JWT bound to
// the provider's operation, run-status check, size cap, path allowlist
// grown from logged rejections, owner-key-else-server-key-else-refuse,
// upstream fetch with SSE passthrough. The Qwen Code CLI sends the run JWT as
// `authorization: Bearer` (Spike Q1) and every vendor here takes the real
// key the same way, so there is no per-kind header builder: api_key is the
// only kind either provider accepts today (credentialKindsForProvider).

const MAX_REQUEST_BYTES = 10 * 1024 * 1024;

export type OpenAiChatCompatGatewayConfig = {
  operation: RunGatewayClaims["operation"];
  provider: CredentialProvider;
  // Upstream prefix the normalized path is appended to, e.g.
  // "https://dashscope-intl.aliyuncs.com/compatible-mode/v1".
  upstreamBase: string;
  // Worker secret binding name for the server-side fallback key (read by
  // name — cloudflare-env.d.ts deliberately doesn't declare provider keys).
  // Normalized (leading "v1/" stripped) paths the CLI is allowed to reach.
  allowedPaths: ReadonlySet<string>;
};

export async function handleOpenAiChatCompatProxy(
  request: Request,
  params: Promise<{ path: string[] }>,
  config: OpenAiChatCompatGatewayConfig,
): Promise<Response> {
  const bindings = env as unknown as Record<string, string | undefined>;
  const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (!token || !bindings.RUNTIME_GATEWAY_SECRET) return new Response("Not found", { status: 404 });
  const claims = await verifyRunGatewayToken(token, bindings.RUNTIME_GATEWAY_SECRET, config.operation);
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
    encryptionKey: bindings.CREDENTIAL_ENCRYPTION_KEY,
  });
  if (!resolved.ok) return new Response(resolved.message, { status: 503 });
  const headers = new Headers();
  headers.set("authorization", `Bearer ${resolved.secret}`);
  headers.set("content-type", request.headers.get("content-type") ?? "application/json");
  headers.set("accept", request.headers.get("accept") ?? "application/json");
  const upstream = await fetch(`${config.upstreamBase}/${normalized}`, { method: "POST", headers, body });
  const responseHeaders = new Headers();
  // Besides the basics, forward retry-after (the vendor's 429 signal) and the
  // OpenAI-style x-ratelimit-* family both vendors document, so the CLI's own
  // backoff sees the real limit state rather than a bare status code.
  for (const [name, value] of upstream.headers) {
    if (["content-type", "cache-control", "request-id", "x-request-id", "retry-after"].includes(name) || name.startsWith("x-ratelimit-")) {
      responseHeaders.set(name, value);
    }
  }
  responseHeaders.set("x-content-type-options", "nosniff");
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}
