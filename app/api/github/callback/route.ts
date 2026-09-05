import { BASE_PATH } from "@/components/basePath";
import { getGitHubAppConfig } from "@/db";
import { consumeGitHubAccountConnectionState } from "@/db/github-installations";
import { getInstallationAccount, GitHubApiError, listUserInstallationRepositoryIds } from "@/lib/github";
import { verifyGitHubStateToken } from "@/lib/github-state";
import { isApiError, requireApiUser } from "@/lib/server-auth";

/** With "Request user authorization during installation" enabled on the App,
    the install redirect carries a one-time `code`. Exchanged here for a user
    token, used for exactly one thing — reading which of the installation's
    repos the installer's own permissions reach — then dropped. Null when the
    exchange fails or the token can't read the installation (e.g. a forged
    installation_id). */
async function installerRepoScope(
  config: { clientId?: string; clientSecret?: string },
  code: string,
  installationId: string,
): Promise<string[] | null> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code }),
  });
  const token = await response.json().catch(() => null) as { access_token?: string } | null;
  if (!token?.access_token) return null;
  return listUserInstallationRepositoryIds(token.access_token, installationId);
}

export async function GET(request: Request) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const url = new URL(request.url);
  const stateToken = url.searchParams.get("state");
  const installationId = url.searchParams.get("installation_id")?.trim();
  // GitHub's installation Configure screen returns without our signed state.
  // Treat that redirect only as navigation: do not trust its installation id,
  // exchange its code, or mutate repository grants. The existing device flow
  // captures fresh member-specific proof after the user returns to Settings.
  if (!stateToken && url.searchParams.get("setup_action") === "update") {
    return Response.redirect(new URL(`${BASE_PATH}/home/settings?section=connections&github=verify`, request.url), 303);
  }
  if (!stateToken || !installationId || installationId.length > 100) {
    return Response.json({ error: "GitHub setup could not be verified" }, { status: 400 });
  }
  const config = getGitHubAppConfig();
  const stateId = await verifyGitHubStateToken(stateToken, config.stateSecret);
  if (!stateId) return Response.json({ error: "GitHub setup could not be verified" }, { status: 400 });
  // The redirect's installation_id alone proves nothing — ids are
  // near-sequential and anyone could have typed one. Proof is the one-time
  // OAuth `code` GitHub appends when "Request user authorization during
  // installation" is on: its token reads which of the installation's repos
  // the installer's own permissions reach. Without a code (or with a failed
  // exchange) the link lands with an empty scope and the return page opens
  // the device dialog to verify instead. Test mode is the fixture installer
  // and gets its full fixture scope.
  const code = url.searchParams.get("code");
  let repoScope: string[] = [];
  try {
    if (config.testData) {
      repoScope = config.testData.repositories.map((repository) => repository.id);
    } else if (code && config.clientId && config.clientSecret) {
      repoScope = await installerRepoScope(config, code, installationId) ?? [];
    }
  } catch {
    const consumed = await consumeGitHubAccountConnectionState(stateId, user.id, installationId, null, []);
    if (!consumed) return Response.json({ error: "GitHub setup has expired or was already used" }, { status: 400 });
    return Response.json({ error: "GitHub installation verification is unavailable" }, { status: 502 });
  }
  const verified = config.testData != null || repoScope.length > 0;
  let account: { login: string; type: string } | null = null;
  if (verified) {
    try {
      account = await getInstallationAccount(config, installationId);
    } catch (error) {
      const consumed = await consumeGitHubAccountConnectionState(stateId, user.id, installationId, null, []);
      if (!consumed) return Response.json({ error: "GitHub setup has expired or was already used" }, { status: 400 });
      if (error instanceof GitHubApiError) return Response.json({ error: "GitHub installation is unavailable" }, { status: error.status === 404 ? 404 : 502 });
      throw error;
    }
  }
  const consumed = await consumeGitHubAccountConnectionState(stateId, user.id, installationId, account, repoScope);
  if (!consumed) return Response.json({ error: "GitHub setup has expired or was already used" }, { status: 400 });
  const returnUrl = consumed.purpose === "onboarding"
    ? new URL(`${BASE_PATH}/onboarding`, request.url)
    : new URL(consumed.returnTo, request.url);
  if (consumed.purpose === "onboarding") returnUrl.searchParams.set("return_to", consumed.returnTo);
  // "connected" = scope captured, nothing more to do; "verify" = the return
  // page should reopen the device dialog to capture it.
  returnUrl.searchParams.set("github", verified ? "connected" : "verify");
  return Response.redirect(returnUrl, 303);
}
