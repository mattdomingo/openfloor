import { getGitHubAppConfig } from "@/db";
import { listAccountGitHubRepositories, resolveAccountGitHubRepository } from "@/db/github-installations";
import { getRepositoryConnectionForMember } from "@/db/repositories";
import { getMembershipRole } from "@/db/sessions";
import { GitHubApiError, listInstallationRepositories, listRepositoryBranches } from "@/lib/github";
import { isApiError, requireApiUser } from "@/lib/server-auth";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const sessionId = (await params).id;
  if ((await getMembershipRole(sessionId, user.id)) !== "owner") {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }
  const existing = await getRepositoryConnectionForMember(sessionId, user.id);
  const existingUsable = existing && !["disconnected", "revoked", "inaccessible"].includes(existing.status);
  try {
    const config = getGitHubAppConfig();
    const repositories = existingUsable
      ? (await listInstallationRepositories(config, existing.installationId)).filter((repository) => repository.id === existing.repositoryId)
      : await listAccountGitHubRepositories(user.id, config);
    const repositoryId = new URL(request.url).searchParams.get("repositoryId");
    if (!repositoryId) return Response.json({ repositories, branches: [] });
    const repository = repositories.find((item) => item.id === repositoryId);
    if (!repository) return Response.json({ error: "Repository is not available to your GitHub account" }, { status: 400 });
    const installationId = existingUsable
      ? existing.installationId
      : (await resolveAccountGitHubRepository(
          user.id,
          "accountInstallationId" in repository && typeof repository.accountInstallationId === "string"
            ? repository.accountInstallationId
            : "",
          repository.id,
          config,
        ))?.installationId;
    if (!installationId) return Response.json({ error: "Repository is not available to your GitHub account" }, { status: 400 });
    const branches = await listRepositoryBranches(config, installationId, repository);
    return Response.json({ repositories, branches });
  } catch (error) {
    if (error instanceof GitHubApiError) {
      return Response.json({ error: "GitHub repository access is unavailable" }, { status: error.status === 404 ? 404 : 502 });
    }
    throw error;
  }
}
