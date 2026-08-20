import { getGitHubAppConfig } from "@/db";
import {
  getActiveRepositoryCandidateForMember,
  getRepositoryConnectionForMember,
  reconcileRepositoryCandidate,
  setRepositoryAvailability,
} from "@/db/repositories";
import { activeOwnerErrorResponse } from "@/lib/floor-api";
import { getInstallationRepository, getRepositoryRefSha, GitHubApiError } from "@/lib/github";
import { notifyFloorChanged } from "@/lib/presence-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const sessionId = (await params).id;
  const ownerError = await activeOwnerErrorResponse(sessionId, user.id);
  if (ownerError) return ownerError;
  const connection = await getRepositoryConnectionForMember(sessionId, user.id);
  const candidate = await getActiveRepositoryCandidateForMember(sessionId, user.id);
  if (!connection || !candidate?.candidateSha || connection.status === "disconnected") {
    return Response.json({ error: "No active repository candidate is available" }, { status: 409 });
  }
  try {
    const config = getGitHubAppConfig();
    const repository = await getInstallationRepository(config, connection.installationId, connection.repositoryId);
    const [remoteBaseSha, remoteCandidateSha] = await Promise.all([
      getRepositoryRefSha(config, connection.installationId, repository, candidate.baseBranch),
      getRepositoryRefSha(config, connection.installationId, repository, candidate.branchName),
    ]);
    const status = remoteCandidateSha === candidate.candidateSha ? "ready" : "externally_modified";
    const revision = await reconcileRepositoryCandidate(sessionId, repository, remoteBaseSha, remoteCandidateSha, status);
    await notifyFloorChanged(sessionId, revision, ["repository", "review"]);
    return Response.json({
      repository: await getRepositoryConnectionForMember(sessionId, user.id),
      candidate: await getActiveRepositoryCandidateForMember(sessionId, user.id),
    });
  } catch (error) {
    if (error instanceof GitHubApiError && (error.status === 403 || error.status === 404)) {
      const revision = await setRepositoryAvailability(sessionId, "inaccessible");
      await notifyFloorChanged(sessionId, revision, ["repository", "review"]);
      return Response.json({ error: "GitHub repository access is unavailable" }, { status: 404 });
    }
    if (error instanceof GitHubApiError) return Response.json({ error: "GitHub synchronization failed" }, { status: 502 });
    throw error;
  }
}
