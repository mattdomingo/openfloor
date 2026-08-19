import { getGitHubAppConfig } from "@/db";
import { getPendingGitHubInstallation, getRepositoryConnectionForMember } from "@/db/repositories";
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
  const pending = await getPendingGitHubInstallation(sessionId, user.id);
  const existing = await getRepositoryConnectionForMember(sessionId, user.id);
  const installationId = pending?.installationId ?? (existing && !["disconnected", "revoked", "inaccessible"].includes(existing.status) ? existing.installationId : null);
  if (!installationId) return Response.json({ error: "GitHub setup is not available" }, { status: 409 });
  try {
    const config = getGitHubAppConfig();
    const allRepositories = await listInstallationRepositories(config, installationId);
    const repositories = pending
      ? allRepositories
      : allRepositories.filter((repository) => repository.id === existing?.repositoryId);
    const repositoryId = new URL(request.url).searchParams.get("repositoryId");
    if (!repositoryId) return Response.json({ repositories, branches: [] });
    const repository = repositories.find((item) => item.id === repositoryId);
    if (!repository) return Response.json({ error: "Repository is not available to this installation" }, { status: 400 });
    const branches = await listRepositoryBranches(config, installationId, repository);
    return Response.json({ repositories, branches });
  } catch (error) {
    if (error instanceof GitHubApiError) {
      return Response.json({ error: "GitHub repository access is unavailable" }, { status: error.status === 404 ? 404 : 502 });
    }
    throw error;
  }
}
