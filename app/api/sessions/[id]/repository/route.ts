import { getGitHubAppConfig } from "@/db";
import {
  disconnectRepository,
  getActiveRepositoryCandidateForMember,
  getPendingGitHubInstallation,
  getRepositoryConnectionForMember,
  getRepositoryFloorRevision,
  saveRepositoryConnection,
} from "@/db/repositories";
import { getMembershipRole } from "@/db/sessions";
import { GitHubApiError, listInstallationRepositories, listRepositoryBranches } from "@/lib/github";
import type { GitHubRepositoryOption } from "@/lib/session-types";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { notifyFloorChanged } from "@/lib/presence-server";
import { parseRepositoryConnectionInput } from "@/lib/validation";
import { activeOwnerErrorResponse, mutationErrorResponse } from "@/lib/floor-api";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const sessionId = (await params).id;
  if (!(await getMembershipRole(sessionId, user.id))) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }
  return Response.json({ repository: await getRepositoryConnectionForMember(sessionId, user.id) });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const sessionId = (await params).id;
  const ownerError = await activeOwnerErrorResponse(sessionId, user.id);
  if (ownerError) return ownerError;
  let pending;
  try {
    pending = await getPendingGitHubInstallation(sessionId, user.id);
  } catch (error) {
    return mutationErrorResponse(error);
  }
  if (!pending) return Response.json({ error: "Session not found" }, { status: 404 });
  const input = await readInput(request);
  if (!input) return Response.json({ error: "Select a valid repository and base branch, with no more than eight valid check commands" }, { status: 400 });
  return configureFromGitHub(sessionId, user.id, pending.stateId, pending.installationId, input);
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const sessionId = (await params).id;
  const ownerError = await activeOwnerErrorResponse(sessionId, user.id);
  if (ownerError) return ownerError;
  const existing = await getRepositoryConnectionForMember(sessionId, user.id);
  if (!existing || (await getMembershipRole(sessionId, user.id)) !== "owner") {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }
  if (["disconnected", "revoked", "inaccessible"].includes(existing.status)) {
    return Response.json({ error: "Reconnect the repository before changing its configuration" }, { status: 409 });
  }
  const input = await readInput(request);
  if (!input) return Response.json({ error: "Select a valid repository and base branch, with no more than eight valid check commands" }, { status: 400 });
  if (input.repositoryId !== existing.repositoryId) {
    return Response.json({ error: "Disconnect before selecting another repository" }, { status: 409 });
  }
  const candidate = await getActiveRepositoryCandidateForMember(sessionId, user.id);
  if (candidate && input.baseBranch !== candidate.baseBranch) {
    return Response.json({ error: "The base branch cannot change while a candidate is active" }, { status: 409 });
  }
  return configureFromGitHub(sessionId, user.id, null, existing.installationId, input);
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const sessionId = (await params).id;
  const ownerError = await activeOwnerErrorResponse(sessionId, user.id);
  if (ownerError) return ownerError;
  let repository;
  try {
    repository = await disconnectRepository(sessionId, user.id);
  } catch (error) {
    return mutationErrorResponse(error);
  }
  if (repository) await notifyFloorChanged(sessionId, await getRepositoryFloorRevision(sessionId), ["repository", "review"]);
  return repository
    ? Response.json({ repository })
    : Response.json({ error: "Session not found" }, { status: 404 });
}

async function configureFromGitHub(
  sessionId: string,
  userId: string,
  stateId: string | null,
  installationId: string,
  input: NonNullable<ReturnType<typeof parseRepositoryConnectionInput>>,
) {
  try {
    const config = getGitHubAppConfig();
    const repositories = await listInstallationRepositories(config, installationId);
    const repository = repositories.find((item) => item.id === input.repositoryId);
    if (!repository) return Response.json({ error: "Repository is not available to this installation" }, { status: 400 });
    const previous = await getRepositoryConnectionForMember(sessionId, userId);
    const historicalCandidate = await getActiveRepositoryCandidateForMember(sessionId, userId);
    if (historicalCandidate && previous && previous.repositoryId !== repository.id) {
      return Response.json({ error: "Reconnect the same repository while a candidate is active" }, { status: 409 });
    }
    const branches = await listRepositoryBranches(config, installationId, repository);
    if (!branches.includes(input.baseBranch)) {
      return Response.json({ error: "Base branch is not available in this repository" }, { status: 400 });
    }
    const saved = await saveRepositoryConnection(
      sessionId,
      userId,
      stateId,
      installationId,
      repository as GitHubRepositoryOption,
      input.baseBranch,
      input.checkCommands,
    );
    if (saved) await notifyFloorChanged(sessionId, await getRepositoryFloorRevision(sessionId), ["repository", "review"]);
    return saved
      ? Response.json({ repository: saved }, { status: stateId ? 201 : 200 })
      : Response.json({ error: "Session not found" }, { status: 404 });
  } catch (error) {
    try { return mutationErrorResponse(error); } catch { /* continue with GitHub mapping */ }
    if (error instanceof GitHubApiError) {
      return Response.json({ error: "GitHub repository access is unavailable" }, { status: error.status === 404 ? 404 : 502 });
    }
    throw error;
  }
}

async function readInput(request: Request) {
  try {
    return parseRepositoryConnectionInput(await request.json());
  } catch {
    return null;
  }
}
