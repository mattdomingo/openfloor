import { createGitHubConnectionState, getRepositoryConnectionForMember } from "@/db/repositories";
import { getGitHubAppConfig } from "@/db";
import { githubInstallationUrl } from "@/lib/github";
import { signGitHubStateId } from "@/lib/github-state";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { activeOwnerErrorResponse, mutationErrorResponse } from "@/lib/floor-api";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const sessionId = (await params).id;
  const ownerError = await activeOwnerErrorResponse(sessionId, user.id);
  if (ownerError) return ownerError;
  const existing = await getRepositoryConnectionForMember(sessionId, user.id);
  if (existing && !["disconnected", "revoked", "inaccessible"].includes(existing.status)) {
    return Response.json({ error: "Disconnect the current repository before connecting another one" }, { status: 409 });
  }
  let stateId;
  try {
    stateId = await createGitHubConnectionState(sessionId, user.id);
  } catch (error) {
    return mutationErrorResponse(error);
  }
  if (!stateId) return Response.json({ error: "Session not found" }, { status: 404 });
  const config = getGitHubAppConfig();
  const state = await signGitHubStateId(stateId, config.stateSecret);
  return Response.json({ installUrl: githubInstallationUrl(config, state) });
}
