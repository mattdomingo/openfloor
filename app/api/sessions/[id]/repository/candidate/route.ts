import { getGitHubAppConfig } from "@/db";
import {
  activateRepositoryCandidate,
  failRepositoryCandidate,
  getActiveRepositoryCandidateForMember,
  getRepositoryConnectionForMember,
  reserveRepositoryCandidate,
  setRepositoryAvailability,
} from "@/db/repositories";
import { getMembershipRole } from "@/db/sessions";
import { createRepositoryBranch, getInstallationRepository, getRepositoryRefSha, GitHubApiError } from "@/lib/github";
import { notifyFloorChanged } from "@/lib/presence-server";
import { openFloorBranchName } from "@/lib/repository-refs";
import { isApiError, requireApiUser } from "@/lib/server-auth";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const sessionId = (await params).id;
  if ((await getMembershipRole(sessionId, user.id)) !== "owner") {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }
  const connection = await getRepositoryConnectionForMember(sessionId, user.id);
  if (!connection || connection.status !== "connected") {
    return Response.json({ error: "Connect an accessible repository before enabling execution" }, { status: 409 });
  }
  if (await getActiveRepositoryCandidateForMember(sessionId, user.id)) {
    return Response.json({ error: "This session already has an active candidate" }, { status: 409 });
  }
  const candidateId = crypto.randomUUID();
  const branchName = openFloorBranchName(sessionId, "candidate", candidateId);
  try {
    const config = getGitHubAppConfig();
    const repository = await getInstallationRepository(config, connection.installationId, connection.repositoryId);
    const baseSha = await getRepositoryRefSha(config, connection.installationId, repository, connection.baseBranch);
    const reserved = await reserveRepositoryCandidate(
      sessionId, user.id, connection.id, candidateId, branchName, connection.baseBranch, baseSha,
    );
    if (!reserved) return Response.json({ error: "This session already has an active candidate" }, { status: 409 });
    try {
      const candidateSha = await createRepositoryBranch(config, connection.installationId, repository, branchName, baseSha);
      if (candidateSha !== baseSha) throw new GitHubApiError("GitHub created the candidate at an unexpected SHA", 502);
      const revision = await activateRepositoryCandidate(sessionId, candidateId, candidateSha);
      await notifyFloorChanged(sessionId, revision, ["repository", "review"]);
      return Response.json({
        repository: await getRepositoryConnectionForMember(sessionId, user.id),
        candidate: await getActiveRepositoryCandidateForMember(sessionId, user.id),
      }, { status: 201 });
    } catch (error) {
      await failRepositoryCandidate(candidateId);
      throw error;
    }
  } catch (error) {
    if (error instanceof GitHubApiError) {
      if (error.status === 403 || error.status === 404) {
        const revision = await setRepositoryAvailability(sessionId, "inaccessible");
        await notifyFloorChanged(sessionId, revision, ["repository", "review"]);
      }
      return Response.json({ error: "GitHub repository access is unavailable" }, { status: error.status === 404 ? 404 : 502 });
    }
    throw error;
  }
}
