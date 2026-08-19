import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { getGitHubAppConfig } from "@/db";
import { getFloorSnapshot } from "@/db/floor";
import { getRunDiscardContext, markRunDiscarded } from "@/db/runs";
import { createInstallationToken, deleteTestRepositoryBranchIfMatches, getRepositoryRefSha, GitHubApiError } from "@/lib/github";
import { notifyFloorChanged } from "@/lib/presence-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import type { GitHubRepositoryOption } from "@/lib/session-types";
import { env } from "cloudflare:workers";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string; runId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id: sessionId, runId } = await params;
  const context = await getRunDiscardContext(sessionId, runId, user.id);
  if (!context) return Response.json({ error: "Session not found" }, { status: 404 });
  if (context.discardedAt) return Response.json({ error: "This run branch was already discarded" }, { status: 409 });
  if (!context.runBranch?.startsWith("openfloor/") || !context.runCommitSha || context.runCommitSha !== context.remoteRunSha) {
    return Response.json({ error: "The recorded run branch cannot be safely discarded" }, { status: 409 });
  }
  const config = getGitHubAppConfig();
  const repository: GitHubRepositoryOption = {
    id: context.repositoryId, nodeId: "discard-not-required", owner: context.repositoryOwner,
    name: context.repositoryName, fullName: context.repositoryFullName,
    private: Boolean(context.repositoryPrivate), defaultBranch: context.defaultBranch,
  };
  try {
    const observed = await getRepositoryRefSha(config, context.installationId, repository, context.runBranch);
    if (observed !== context.runCommitSha) return Response.json({ error: "GitHub changed this run branch; OpenFloor refused to delete it" }, { status: 409 });
    if (config.testData) {
      if (!(await deleteTestRepositoryBranchIfMatches(config, context.installationId, repository, context.runBranch, context.runCommitSha))) {
        return Response.json({ error: "GitHub changed this run branch; OpenFloor refused to delete it" }, { status: 409 });
      }
    } else {
      const bindings = env as unknown as { SANDBOX?: DurableObjectNamespace<Sandbox> };
      if (!bindings.SANDBOX) return Response.json({ error: "Safe branch deletion is unavailable" }, { status: 503 });
      const sandbox = getSandbox(bindings.SANDBOX, `discard-${runId}`, { keepAlive: false, enableDefaultSession: false, normalizeId: true });
      try {
        const token = await createInstallationToken(config, context.installationId, context.repositoryId);
        const result = await sandbox.exec(
          `rm -rf /tmp/openfloor-discard && mkdir /tmp/openfloor-discard && cd /tmp/openfloor-discard && git init -q &&
           git remote add origin "$OPENFLOOR_REPOSITORY_URL" &&
           git -c credential.helper= -c "http.extraHeader=Authorization: Bearer $OPENFLOOR_GITHUB_TOKEN" push
             "--force-with-lease=refs/heads/$OPENFLOOR_RUN_BRANCH:$OPENFLOOR_EXPECTED_SHA" origin ":refs/heads/$OPENFLOOR_RUN_BRANCH"`,
          { timeout: 2 * 60 * 1000, env: {
            OPENFLOOR_REPOSITORY_URL: `https://github.com/${context.repositoryOwner}/${context.repositoryName}.git`,
            OPENFLOOR_GITHUB_TOKEN: token,
            OPENFLOOR_RUN_BRANCH: context.runBranch,
            OPENFLOOR_EXPECTED_SHA: context.runCommitSha,
          } },
        );
        if (!result.success) return Response.json({ error: "GitHub changed this run branch; OpenFloor refused to delete it" }, { status: 409 });
      } finally {
        await sandbox.destroy().catch(() => undefined);
      }
    }
    const revision = await markRunDiscarded(sessionId, runId, user.id);
    if (revision === null) return Response.json({ error: "This run branch can no longer be discarded" }, { status: 409 });
    const floor = await getFloorSnapshot(sessionId, user.id);
    if (!floor) return Response.json({ error: "Session not found" }, { status: 404 });
    await notifyFloorChanged(sessionId, revision, ["runs", "review"]);
    return Response.json({ floor });
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return Response.json({ error: "The recorded run branch no longer exists on GitHub" }, { status: 409 });
    return Response.json({ error: "The run branch could not be safely discarded" }, { status: 502 });
  }
}
