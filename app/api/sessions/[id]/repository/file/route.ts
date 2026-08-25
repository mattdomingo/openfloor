import { getDb, getGitHubAppConfig } from "@/db";
import { getLatestRepositoryReviewCandidate, getRepositoryConnectionForMember } from "@/db/repositories";
import { GitHubApiError, getRepositoryFileContent } from "@/lib/github";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import type { GitHubRepositoryOption } from "@/lib/session-types";

/* Read-only file content for the Review screen's repository browser. Same access model as
   ./tree/route.ts: any session member, no quota gate, ref resolved server-side. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const sessionId = (await params).id;
  const path = new URL(request.url).searchParams.get("path");
  if (!path) return Response.json({ error: "A file path is required" }, { status: 400 });
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
    const file = await getRepositoryFileContent(config, repository.installationId, option, ref, path);
    return Response.json(file);
  } catch (error) {
    if (error instanceof GitHubApiError) {
      const status = error.status === 404 ? 404 : error.status === 400 ? 400 : 502;
      return Response.json({ error: "GitHub repository access is unavailable" }, { status });
    }
    throw error;
  }
}
