import { BASE_PATH } from "@/components/basePath";
import { getGitHubAppConfig } from "@/db";
import { consumeGitHubAccountConnectionState } from "@/db/github-installations";
import { getInstallationAccount, GitHubApiError } from "@/lib/github";
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
  let account;
  try {
    account = await getInstallationAccount(config, installationId);
  } catch (error) {
    if (error instanceof GitHubApiError) return Response.json({ error: "GitHub installation is unavailable" }, { status: error.status === 404 ? 404 : 502 });
    throw error;
  }
  // The redirect carries an installation_id anyone could have typed — ids are
  // near-sequential — and this route holds no user token to prove access. So
  // the link lands with an empty repo scope; the device-flow reconnect the
  // return page opens captures the member's real scope. Test mode is the
  // fixture installer and gets its full fixture scope.
  const repoScope = config.testData ? config.testData.repositories.map((repository) => repository.id) : [];
  const consumed = await consumeGitHubAccountConnectionState(stateId, user.id, installationId, account, repoScope);
  if (!consumed) return Response.json({ error: "GitHub setup has expired or was already used" }, { status: 400 });
  const returnUrl = consumed.purpose === "onboarding"
    ? new URL(`${BASE_PATH}/onboarding`, request.url)
    : new URL(consumed.returnTo, request.url);
  if (consumed.purpose === "onboarding") {
    returnUrl.searchParams.set("return_to", consumed.returnTo);
    returnUrl.searchParams.set("github", "connected");
  } else {
    returnUrl.searchParams.set("github", "connected");
  }
  return Response.redirect(returnUrl, 303);
}
