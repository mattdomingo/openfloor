import { getRunGatewayContext } from "@/db/runs";
import { verifyRunGatewayToken } from "@/lib/runtime-token";
import { env } from "cloudflare:workers";

const MAX_REQUEST_BYTES = 10 * 1024 * 1024;

export async function POST(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const bindings = env as unknown as { RUNTIME_GATEWAY_SECRET?: string; OPENAI_API_KEY?: string };
  const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (!token || !bindings.RUNTIME_GATEWAY_SECRET || !bindings.OPENAI_API_KEY) return new Response("Not found", { status: 404 });
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
  const headers = new Headers();
  headers.set("authorization", `Bearer ${bindings.OPENAI_API_KEY}`);
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
