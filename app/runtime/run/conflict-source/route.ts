import { getGitHubAppConfig } from "@/db";
import { getConflictRunContext } from "@/db/conflicts";
import { downloadRepositoryArchive } from "@/lib/github";
import { verifyRunGatewayToken } from "@/lib/runtime-token";
import type { GitHubRepositoryOption } from "@/lib/session-types";
import { env } from "cloudflare:workers";

const MAX_BUNDLE_BYTES = 25 * 1024 * 1024;
type R2ObjectLike = { body: ReadableStream; size: number };
type R2BucketLike = { get(key: string): Promise<R2ObjectLike | null> };

export async function GET(request: Request) {
  const bindings = env as unknown as { RUNTIME_GATEWAY_SECRET?: string; PREFLIGHT_LOGS?: R2BucketLike };
  const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (!token || !bindings.RUNTIME_GATEWAY_SECRET) return new Response("Not found", { status: 404 });
  const claims = await verifyRunGatewayToken(token, bindings.RUNTIME_GATEWAY_SECRET, "conflict_source");
  if (!claims) return new Response("Not found", { status: 404 });
  const context = await getConflictRunContext(claims.runId);
  if (!context || context.sessionId !== claims.sessionId || context.repositoryId !== claims.repositoryId
    || context.resolverCandidateSha !== claims.candidateSha
    || !["provisioning", "running", "checking", "cancel_requested"].includes(context.resolverStatus)) {
    return new Response("Not found", { status: 404 });
  }
  const part = new URL(request.url).searchParams.get("part");
  if (part === "bundle") {
    if (!bindings.PREFLIGHT_LOGS || !context.sourceBundleKey) return new Response("Not found", { status: 404 });
    const object = await bindings.PREFLIGHT_LOGS.get(context.sourceBundleKey);
    if (!object || object.size <= 0 || object.size > MAX_BUNDLE_BYTES) return new Response("Not found", { status: 404 });
    return new Response(object.body, {
      headers: { "content-type": "application/x-git-bundle", "content-length": String(object.size), "cache-control": "no-store" },
    });
  }
  if (part !== "base") return new Response("Not found", { status: 404 });
  const repository: GitHubRepositoryOption = {
    id: context.repositoryId, nodeId: "gateway-not-required", owner: context.repositoryOwner,
    name: context.repositoryName, fullName: context.repositoryFullName, private: true, defaultBranch: "gateway-not-required",
  };
  const archive = await downloadRepositoryArchive(getGitHubAppConfig(), context.installationId, repository, context.sourceCandidateSha);
  return new Response(archive.body, {
    headers: { "content-type": "application/x-gzip", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}
