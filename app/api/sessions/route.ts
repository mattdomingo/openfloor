import { BASE_PATH } from "@/components/basePath";
import { getGitHubAppConfig, getInviteSigningSecret } from "@/db";
import { hasActiveUserGitHubInstallation, resolveAccountGitHubRepository } from "@/db/github-installations";
import { getActiveRepositoryCandidateForMember, getRepositoryConnectionForMember } from "@/db/repositories";
import { createSessionWithRepository, hourQuotaExhausted } from "@/db/sessions";
import { getRepositoryRefSha, GitHubApiError } from "@/lib/github";
import { signInviteId } from "@/lib/invites";
import { provisionReservedRepositoryCandidate } from "@/lib/repository-provisioning";
import { openFloorBranchName } from "@/lib/repository-refs";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { parseSessionCreateInput } from "@/lib/validation";

const SETUP_ERROR = "Candidate branch provisioning failed. Retry from the session lobby.";

export async function POST(request: Request) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  if (user.onboardedAt == null) {
    return Response.json({ error: "Complete onboarding before creating a session", code: "onboarding_required" }, { status: 403 });
  }
  if (!(await hasActiveUserGitHubInstallation(user.id))) {
    return Response.json({ error: "Connect GitHub in Account Settings before creating a session", code: "github_required" }, { status: 409 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const input = parseSessionCreateInput(body);
  if (!input) {
    return Response.json({ error: "A title and accessible GitHub repository are required" }, { status: 400 });
  }
  if (await hourQuotaExhausted(user.id)) {
    return Response.json({ error: "Your plan's monthly session hours are used up.", code: "quota_exhausted" }, { status: 403 });
  }

  const config = getGitHubAppConfig();
  let resolved: Awaited<ReturnType<typeof resolveAccountGitHubRepository>>;
  let baseSha: string;
  try {
    resolved = await resolveAccountGitHubRepository(user.id, input.accountInstallationId, input.repositoryId, config);
    if (!resolved) {
      return Response.json({ error: "Repository is not available to this GitHub account installation" }, { status: 400 });
    }
    baseSha = await getRepositoryRefSha(config, resolved.installationId, resolved.repository, resolved.repository.defaultBranch);
  } catch (error) {
    if (error instanceof GitHubApiError) {
      return Response.json({ error: "GitHub repository access is unavailable" }, { status: error.status === 404 ? 400 : 502 });
    }
    throw error;
  }

  const sessionId = crypto.randomUUID();
  const candidateId = crypto.randomUUID();
  const branchName = openFloorBranchName(sessionId, "candidate", candidateId, input.title);
  const created = await createSessionWithRepository(
    user.id,
    input,
    { ...resolved.repository, installationId: resolved.installationId },
    { id: candidateId, branchName, baseSha },
    sessionId,
  );
  const token = await signInviteId(created.inviteId, getInviteSigningSecret());
  const inviteUrl = new URL(`${BASE_PATH}/join/${encodeURIComponent(token)}`, request.url).toString();

  let setupStatus: "ready" | "failed" = "ready";
  let setupError: string | null = null;
  try {
    await provisionReservedRepositoryCandidate({
      config,
      sessionId,
      candidateId,
      installationId: resolved.installationId,
      repository: resolved.repository,
      branchName,
      baseSha,
    });
  } catch {
    setupStatus = "failed";
    setupError = SETUP_ERROR;
  }

  return Response.json({
    session: created.session,
    inviteUrl,
    repository: await getRepositoryConnectionForMember(sessionId, user.id),
    candidate: await getActiveRepositoryCandidateForMember(sessionId, user.id),
    setupStatus,
    setupError,
  }, { status: 201 });
}
