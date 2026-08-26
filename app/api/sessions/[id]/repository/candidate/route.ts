import { getGitHubAppConfig } from "@/db";
import {
  activateRepositoryCandidate,
  failRepositoryCandidate,
  getActiveRepositoryCandidateForMember,
  getRepositoryConnectionForMember,
  reserveRepositoryCandidate,
  setRepositoryAvailability,
} from "@/db/repositories";
import { getFloorSnapshot } from "@/db/floor";
import { getSessionForMember } from "@/db/sessions";
import { abandonSessionCandidate } from "@/lib/candidate-abandon";
import { activeOwnerErrorResponse, mutationErrorResponse } from "@/lib/floor-api";
import { createRepositoryBranch, getInstallationRepository, getRepositoryRefSha, GitHubApiError } from "@/lib/github";
import { notifyFloorChanged } from "@/lib/presence-server";
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
    return Response.json({ error: "Connect an accessible repository before enabling execution" }, { status: 409 });
  }
  if (await getActiveRepositoryCandidateForMember(sessionId, user.id)) {
    return Response.json({ error: "This session already has an active candidate" }, { status: 409 });
  }
  const session = await getSessionForMember(sessionId, user.id);
  if (!session) return Response.json({ error: "Session not found" }, { status: 404 });
  const inputText = await request.text();
  let rawInput: unknown = null;
  if (inputText.trim()) {
    try {
      rawInput = JSON.parse(inputText);
    } catch {
      return Response.json({ error: "Candidate name or description is invalid" }, { status: 400 });
    }
  }
  const input = rawInput === null ? { name: session.title, description: session.objective ?? "" } : parseRepositoryCandidateInput(rawInput);
  if (!input) return Response.json({ error: "Candidate name or description is invalid" }, { status: 400 });
  const candidateId = crypto.randomUUID();
  const branchName = openFloorBranchName(sessionId, "candidate", candidateId, input.name);
  try {
    const config = getGitHubAppConfig();
    const repository = await getInstallationRepository(config, connection.installationId, connection.repositoryId);
    const baseSha = await getRepositoryRefSha(config, connection.installationId, repository, connection.baseBranch);
    const reserved = await reserveRepositoryCandidate(
      sessionId, user.id, connection.id, candidateId, input.name, input.description, branchName, connection.baseBranch, baseSha,
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
    try { return mutationErrorResponse(error); } catch { /* continue with GitHub mapping */ }
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

/* Owner-initiated abandonment of the session's live candidate — makes the
   "merge or abandon it first" copy on session/account deletion true, and is
   also reachable directly from Review as a standalone action. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const sessionId = (await params).id;
  const ownerError = await activeOwnerErrorResponse(sessionId, user.id);
  if (ownerError) return ownerError;
  const inputText = await request.text();
  let deleteBranch = false;
  if (inputText.trim()) {
    try {
      const body = JSON.parse(inputText) as { deleteBranch?: unknown } | null;
      deleteBranch = Boolean(body?.deleteBranch);
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }
  const result = await abandonSessionCandidate(sessionId, user.id, { deleteBranch });
  if (result.outcome === "no_candidate") return Response.json({ error: "There is no candidate to abandon" }, { status: 409 });
  if (result.outcome === "blocked") {
    return Response.json({ error: "The candidate is still being updated", runId: result.runId }, { status: 409 });
  }
  await notifyFloorChanged(sessionId, result.revision, ["repository", "review"]);
  const floor = await getFloorSnapshot(sessionId, user.id);
  if (!floor) return Response.json({ error: "Session not found" }, { status: 404 });
  if (deleteBranch && !result.branchDeleted) {
    return Response.json({ floor, warning: "The candidate branch is still on GitHub — it was not deleted." });
  }
  return Response.json({ floor });
}
