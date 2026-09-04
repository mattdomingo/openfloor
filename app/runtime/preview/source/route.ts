import { env } from "cloudflare:workers";
import { getGitHubAppConfig } from "@/db";
import { getRepositoryPreviewExecutionContext } from "@/db/previews";
import { downloadRepositoryArchive } from "@/lib/github";
import { verifyPreviewGatewayToken } from "@/lib/runtime-token";
import type { GitHubRepositoryOption } from "@/lib/session-types";

export async function GET(request: Request) {
  if ((env as unknown as { REPOSITORY_PREVIEW_ENABLED?: string }).REPOSITORY_PREVIEW_ENABLED !== "true") {
    return new Response("Not found", { status: 404 });
  }
  const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  const secret = (env as unknown as { RUNTIME_GATEWAY_SECRET?: string }).RUNTIME_GATEWAY_SECRET;
  if (!token || !secret) return new Response("Not found", { status: 404 });
  const claims = await verifyPreviewGatewayToken(token, secret);
  if (!claims) return new Response("Not found", { status: 404 });
  const context = await getRepositoryPreviewExecutionContext(claims.previewId, claims.generation);
  if (!context || context.sessionId !== claims.sessionId || context.repositoryId !== claims.repositoryId
    || context.candidateSha !== claims.candidateSha) return new Response("Not found", { status: 404 });
  const repository: GitHubRepositoryOption = {
    id: context.repositoryId,
    nodeId: "gateway-not-required",
    owner: context.repositoryOwner,
    name: context.repositoryName,
    fullName: `${context.repositoryOwner}/${context.repositoryName}`,
    private: true,
    defaultBranch: "gateway-not-required",
  };
  const archive = await downloadRepositoryArchive(
    getGitHubAppConfig(), context.installationId, repository, context.candidateSha,
  );
  return new Response(archive.body, {
    headers: {
      "content-type": "application/x-gzip",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
