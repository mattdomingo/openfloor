import { getGitHubAppConfig } from "@/db";
import { getRunExecutionContext } from "@/db/runs";
import { downloadRepositoryArchive } from "@/lib/github";
import { verifyRunGatewayToken } from "@/lib/runtime-token";
import type { GitHubRepositoryOption } from "@/lib/session-types";
import { env } from "cloudflare:workers";

export async function GET(request: Request) {
  const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  const secret = (env as unknown as { RUNTIME_GATEWAY_SECRET?: string }).RUNTIME_GATEWAY_SECRET;
  if (!token || !secret) return new Response("Not found", { status: 404 });
  const claims = await verifyRunGatewayToken(token, secret, "source");
  if (!claims) return new Response("Not found", { status: 404 });
  const context = await getRunExecutionContext(claims.runId);
  if (
    !context || context.sessionId !== claims.sessionId || context.repositoryId !== claims.repositoryId
    || context.candidateSha !== claims.candidateSha
    || !["provisioning", "running", "checking", "cancel_requested"].includes(context.status)
  ) return new Response("Not found", { status: 404 });
  const repository: GitHubRepositoryOption = {
    id: context.repositoryId,
    nodeId: "gateway-not-required",
    owner: context.repositoryOwner,
    name: context.repositoryName,
    fullName: context.repositoryFullName,
    private: true,
    defaultBranch: "gateway-not-required",
  };
  const archive = await downloadRepositoryArchive(getGitHubAppConfig(), context.installationId, repository, context.candidateSha);
  return new Response(archive.body, {
    headers: { "content-type": "application/x-gzip", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}
