import { getGitHubAppConfig } from "@/db";
import {
  getActiveRepositoryCandidateForMember,
  getLatestFailedRepositoryCandidateForOwner,
  getRepositoryConnectionForMember,
  getRepositoryFloorRevision,
  reactivateFailedRepositoryCandidate,
  reserveRepositoryCandidate,
  setRepositoryAvailability,
} from "@/db/repositories";
import { getSessionForMember } from "@/db/sessions";
import { activeOwnerErrorResponse, mutationErrorResponse } from "@/lib/floor-api";
import { getInstallationRepository, getRepositoryRefSha, GitHubApiError } from "@/lib/github";
import { notifyFloorChanged } from "@/lib/presence-server";
import { provisionReservedRepositoryCandidate } from "@/lib/repository-provisioning";
import { openFloorBranchName } from "@/lib/repository-refs";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { parseRepositoryCandidateInput } from "@/lib/validation";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const sessionId = (await params).id;
  const ownerError = await activeOwnerErrorResponse(sessionId, user.id);
  if (ownerError) return ownerError;
  const connection = await getRepositoryConnectionForMember(sessionId, user.id);
  if (!connection || connection.status !== "connected") {
    return Response.json({ error: "Select an accessible account repository before retrying candidate setup" }, { status: 409 });
  }
  if (await getActiveRepositoryCandidateForMember(sessionId, user.id)) {
    return Response.json({ error: "This session already has an active candidate" }, { status: 409 });
  }
  const session = await getSessionForMember(sessionId, user.id);
  if (!session) return Response.json({ error: "Session not found" }, { status: 404 });
  const input = await readInput(request, session.title, session.objective ?? "");
  if (!input) return Response.json({ error: "Candidate name or description is invalid" }, { status: 400 });

  try {
    const config = getGitHubAppConfig();
    const repository = await getInstallationRepository(config, connection.installationId, connection.repositoryId);
    const failed = await getLatestFailedRepositoryCandidateForOwner(sessionId, user.id);
    if (failed && failed.connectionId === connection.id && await reactivateFailedRepositoryCandidate(sessionId, failed.id)) {
      try {
        await provisionReservedRepositoryCandidate({
          config,
          sessionId,
          candidateId: failed.id,
          installationId: connection.installationId,
          repository,
          branchName: failed.branchName,
          baseSha: failed.baseSha,
        });
        return readyResponse(sessionId, user.id);
      } catch (error) {
        if (!(error instanceof GitHubApiError) || error.status !== 409) throw error;
        // Ref belongs to outside work. Preserve it and record a new candidate attempt below.
      }
    }

    const baseSha = await getRepositoryRefSha(config, connection.installationId, repository, connection.baseBranch);
    const candidateId = crypto.randomUUID();
    const branchName = openFloorBranchName(sessionId, "candidate", candidateId, input.name);
    const reserved = await reserveRepositoryCandidate(
      sessionId, user.id, connection.id, candidateId, input.name, input.description, branchName, connection.baseBranch, baseSha,
    );
    if (!reserved) return Response.json({ error: "Candidate setup is already in progress" }, { status: 409 });
    await provisionReservedRepositoryCandidate({
      config,
      sessionId,
      candidateId,
      installationId: connection.installationId,
      repository,
      branchName,
      baseSha,
    });
    return readyResponse(sessionId, user.id);
  } catch (error) {
    try { return mutationErrorResponse(error); } catch { /* use GitHub mapping */ }
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

async function readyResponse(sessionId: string, userId: string) {
  await notifyFloorChanged(sessionId, await getRepositoryFloorRevision(sessionId), ["repository", "review"]);
  return Response.json({
    repository: await getRepositoryConnectionForMember(sessionId, userId),
    candidate: await getActiveRepositoryCandidateForMember(sessionId, userId),
  }, { status: 201 });
}

async function readInput(request: Request, name: string, description: string) {
  const text = await request.text();
  if (!text.trim()) return { name, description };
  try { return parseRepositoryCandidateInput(JSON.parse(text)); } catch { return null; }
}
