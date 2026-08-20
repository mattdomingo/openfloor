import { getRunGatewayContext } from "@/db/runs";
import { verifyRunGatewayToken } from "@/lib/runtime-token";
import { env } from "cloudflare:workers";

const MAX_BUNDLE_BYTES = 25 * 1024 * 1024;
type R2ObjectLike = { body: ReadableStream; size: number };
type R2BucketLike = {
  put(key: string, value: ArrayBuffer, options?: unknown): Promise<unknown>;
  get(key: string): Promise<R2ObjectLike | null>;
};

export async function POST(request: Request) {
  const bindings = env as unknown as { RUNTIME_GATEWAY_SECRET?: string; PREFLIGHT_LOGS?: R2BucketLike };
  const token = bearer(request);
  if (!token || !bindings.RUNTIME_GATEWAY_SECRET || !bindings.PREFLIGHT_LOGS) return new Response("Not found", { status: 404 });
  const claims = await verifyRunGatewayToken(token, bindings.RUNTIME_GATEWAY_SECRET, "bundle_upload");
  if (!claims) return new Response("Not found", { status: 404 });
  const context = await getRunGatewayContext(claims.runId);
  if (!context || !matches(context, claims) || context.status !== "ready") return new Response("Not found", { status: 404 });
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BUNDLE_BYTES) return new Response("Payload too large", { status: 413 });
  const body = await request.arrayBuffer();
  if (body.byteLength === 0 || body.byteLength > MAX_BUNDLE_BYTES) return new Response("Payload too large", { status: 413 });
  const key = `runs/${claims.runId}/result.bundle`;
  await bindings.PREFLIGHT_LOGS.put(key, body, { httpMetadata: { contentType: "application/x-git-bundle" } });
  return Response.json({ key, size: body.byteLength });
}

export async function GET(request: Request) {
  const bindings = env as unknown as { RUNTIME_GATEWAY_SECRET?: string; PREFLIGHT_LOGS?: R2BucketLike };
  const token = bearer(request);
  if (!token || !bindings.RUNTIME_GATEWAY_SECRET || !bindings.PREFLIGHT_LOGS) return new Response("Not found", { status: 404 });
  const claims = await verifyRunGatewayToken(token, bindings.RUNTIME_GATEWAY_SECRET, "bundle_read");
  if (!claims) return new Response("Not found", { status: 404 });
  const context = await getRunGatewayContext(claims.runId);
  if (!context || !matches(context, claims) || context.status !== "publishing" || !context.bundleKey) return new Response("Not found", { status: 404 });
  const object = await bindings.PREFLIGHT_LOGS.get(context.bundleKey);
  if (!object || object.size > MAX_BUNDLE_BYTES) return new Response("Not found", { status: 404 });
  return new Response(object.body, {
    headers: { "content-type": "application/x-git-bundle", "content-length": String(object.size), "cache-control": "no-store" },
  });
}

function bearer(request: Request) {
  return request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1] ?? null;
}

function matches(context: Awaited<ReturnType<typeof getRunGatewayContext>>, claims: { sessionId: string; repositoryId: string; candidateSha: string }) {
  return Boolean(context && context.sessionId === claims.sessionId && context.repositoryId === claims.repositoryId && context.candidateSha === claims.candidateSha);
}
