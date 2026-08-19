import { BASE_PATH } from "@/components/basePath";
import { getGitHubAppConfig } from "@/db";
import { consumeGitHubConnectionState } from "@/db/repositories";
import { verifyGitHubStateToken } from "@/lib/github-state";
import { isApiError, requireApiUser } from "@/lib/server-auth";

export async function GET(request: Request) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const url = new URL(request.url);
  const stateToken = url.searchParams.get("state");
  const installationId = url.searchParams.get("installation_id")?.trim();
  if (!stateToken || !installationId || installationId.length > 100) {
    return Response.json({ error: "GitHub setup could not be verified" }, { status: 400 });
  }
  const config = getGitHubAppConfig();
  const stateId = await verifyGitHubStateToken(stateToken, config.stateSecret);
  if (!stateId) return Response.json({ error: "GitHub setup could not be verified" }, { status: 400 });
  const consumed = await consumeGitHubConnectionState(stateId, user.id, installationId);
  if (!consumed) return Response.json({ error: "GitHub setup has expired or was already used" }, { status: 400 });
  const returnUrl = new URL(`${BASE_PATH}/session/${encodeURIComponent(consumed.sessionId)}`, request.url);
  returnUrl.searchParams.set("github", "setup");
  return Response.redirect(returnUrl, 303);
}
