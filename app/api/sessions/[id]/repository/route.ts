import { getGitHubAppConfig } from "@/db";
import { resolveAccountGitHubRepository } from "@/db/github-installations";
import {
  disconnectRepository,
  getActiveRepositoryCandidateForMember,
  getRepositoryConnectionForMember,
  getRepositoryFloorRevision,
  reserveRepositoryCandidate,
  saveRepositoryConnection,
} from "@/db/repositories";
import { getMembershipRole, getSessionForMember } from "@/db/sessions";
import { activeOwnerErrorResponse, mutationErrorResponse } from "@/lib/floor-api";
import {
  getInstallationRepository,
  getRepositoryRefSha,
  GitHubApiError,
  listRepositoryBranches,
} from "@/lib/github";
import { notifyFloorChanged } from "@/lib/presence-server";
import { provisionReservedRepositoryCandidate } from "@/lib/repository-provisioning";
import { openFloorBranchName } from "@/lib/repository-refs";
import type { GitHubRepositoryOption } from "@/lib/session-types";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { parseRepositoryConnectionInput } from "@/lib/validation";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const sessionId = (await params).id;
  if (!(await getMembershipRole(sessionId, user.id))) return Response.json({ error: "Session not found" }, { status: 404 });
  return Response.json({ repository: await getRepositoryConnectionForMember(sessionId, user.id) });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const sessionId = (await params).id;
  const ownerError = await activeOwnerErrorResponse(sessionId, user.id);
  if (ownerError) return ownerError;
  const input = await readInput(request);
  if (!input?.accountInstallationId) {
    return Response.json({ error: "Select a repository from an active Account Settings GitHub installation" }, { status: 400 });
  }
  try {
    const config = getGitHubAppConfig();
    const resolved = await resolveAccountGitHubRepository(
      user.id,
      input.accountInstallationId,
      input.repositoryId,
      config,
    );
    if (!resolved) return Response.json({ error: "Repository is not available to your GitHub account" }, { status: 400 });
    return configureFromGitHub(
      sessionId,
      user.id,
      resolved.installationId,
      resolved.repository,
      { ...input, baseBranch: resolved.repository.defaultBranch },
      true,
    );
  } catch (error) {
    return githubErrorResponse(error);
  }
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
    return Response.json({ error: "Reconnect from an active GitHub installation in Account Settings" }, { status: 409 });
  }
  const input = await readInput(request);
  if (!input) return Response.json({ error: "Select a valid repository and base branch, with no more than eight valid check commands" }, { status: 400 });
  if (input.repositoryId !== existing.repositoryId) return Response.json({ error: "Disconnect before selecting another repository" }, { status: 409 });
  const candidate = await getActiveRepositoryCandidateForMember(sessionId, user.id);
  if (candidate && input.baseBranch !== candidate.baseBranch) {
    return Response.json({ error: "The base branch cannot change while a candidate is active" }, { status: 409 });
  }
  try {
    const config = getGitHubAppConfig();
    const repository = await getInstallationRepository(config, existing.installationId, existing.repositoryId);
    return configureFromGitHub(sessionId, user.id, existing.installationId, repository, input, false);
  } catch (error) {
    return githubErrorResponse(error);
  }
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
  return repository ? Response.json({ repository }) : Response.json({ error: "Session not found" }, { status: 404 });
}

async function configureFromGitHub(
  sessionId: string,
  userId: string,
  installationId: string,
  repository: GitHubRepositoryOption,
  input: NonNullable<ReturnType<typeof parseRepositoryConnectionInput>>,
  provisionCandidate: boolean,
) {
  const config = getGitHubAppConfig();
  const previous = await getRepositoryConnectionForMember(sessionId, userId);
  const historicalCandidate = await getActiveRepositoryCandidateForMember(sessionId, userId);
  if (historicalCandidate && previous && previous.repositoryId !== repository.id) {
    return Response.json({ error: "Reconnect the same repository while a candidate is active" }, { status: 409 });
  }
  const branches = await listRepositoryBranches(config, installationId, repository);
  if (!branches.includes(input.baseBranch)) return Response.json({ error: "Base branch is not available in this repository" }, { status: 400 });
  const saved = await saveRepositoryConnection(sessionId, userId, null, installationId, repository, input.baseBranch, input.checkCommands);
  if (!saved) return Response.json({ error: "Session not found" }, { status: 404 });
  await notifyFloorChanged(sessionId, await getRepositoryFloorRevision(sessionId), ["repository", "review"]);

  if (!provisionCandidate || historicalCandidate) return Response.json({ repository: saved }, { status: provisionCandidate ? 201 : 200 });
  const session = await getSessionForMember(sessionId, userId);
  if (!session) return Response.json({ error: "Session not found" }, { status: 404 });
  const baseSha = await getRepositoryRefSha(config, installationId, repository, input.baseBranch);
  const candidateId = crypto.randomUUID();
  const branchName = openFloorBranchName(sessionId, "candidate", candidateId, session.title);
  const reserved = await reserveRepositoryCandidate(
    sessionId, userId, saved.id, candidateId, session.title, session.objective ?? "", branchName, input.baseBranch, baseSha,
  );
  if (!reserved) return Response.json({ repository: saved, setupStatus: "failed", setupError: "Candidate setup is already in progress." }, { status: 201 });
  try {
    await provisionReservedRepositoryCandidate({ config, sessionId, candidateId, installationId, repository, branchName, baseSha });
    await notifyFloorChanged(sessionId, await getRepositoryFloorRevision(sessionId), ["repository", "review"]);
    return Response.json({
      repository: await getRepositoryConnectionForMember(sessionId, userId),
      candidate: await getActiveRepositoryCandidateForMember(sessionId, userId),
      setupStatus: "ready",
    }, { status: 201 });
  } catch {
    return Response.json({ repository: saved, candidate: null, setupStatus: "failed", setupError: "Candidate branch provisioning failed. Retry from this lobby." }, { status: 201 });
  }
}

function githubErrorResponse(error: unknown): Response {
  try { return mutationErrorResponse(error); } catch { /* use GitHub mapping */ }
  if (error instanceof GitHubApiError) {
    return Response.json({ error: "GitHub repository access is unavailable" }, { status: error.status === 404 ? 404 : 502 });
  }
  throw error;
}

async function readInput(request: Request) {
  try { return parseRepositoryConnectionInput(await request.json()); } catch { return null; }
}
