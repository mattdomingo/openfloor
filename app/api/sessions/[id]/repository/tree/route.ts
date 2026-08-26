import { getDb, getGitHubAppConfig } from "@/db";
import { getLatestRepositoryReviewCandidate, getRepositoryConnectionForMember } from "@/db/repositories";
import { GitHubApiError, listRepositoryTree } from "@/lib/github";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import type { GitHubRepositoryOption } from "@/lib/session-types";

/* Read-only repository browsing for the Review screen: any session member (not just the owner)
   can list the tree at the candidate head, or the connection's base branch before a candidate
   exists. This never spends quota or writes to GitHub, so it skips activeOwnerErrorResponse and
   quotaExhaustedErrorResponse — see the "wind-down set" convention in AGENTS.md. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const sessionId = (await params).id;
  const database = getDb();
  const repository = await getRepositoryConnectionForMember(sessionId, user.id, database);
  if (!repository) return Response.json({ error: "Session not found" }, { status: 404 });
  if (["disconnected", "revoked", "inaccessible"].includes(repository.status)) {
    return Response.json({ error: "Repository is not connected" }, { status: 409 });
  }
  const candidate = await getLatestRepositoryReviewCandidate(sessionId, database);
  const ref = candidate?.candidateSha ?? repository.baseBranch;
  const option: GitHubRepositoryOption = {
    id: repository.repositoryId,
    nodeId: repository.repositoryNodeId,
    owner: repository.repositoryOwner,
    name: repository.repositoryName,
    fullName: repository.repositoryFullName,
    private: repository.repositoryPrivate,
    defaultBranch: repository.defaultBranch,
  };
  try {
    const config = getGitHubAppConfig();
    const tree = await listRepositoryTree(config, repository.installationId, option, ref);
    return Response.json(tree);
  } catch (error) {
    if (error instanceof GitHubApiError) {
      return Response.json({ error: "GitHub repository access is unavailable" }, { status: error.status === 404 ? 404 : 502 });
    }
    throw error;
  }
}
