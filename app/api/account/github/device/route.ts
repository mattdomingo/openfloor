// GitHub device-flow connect, for clients where a browser redirect round trip
// is awkward (the desktop app) and as the primary connect UX everywhere:
// POST starts the flow (the UI shows the user code and opens
// github.com/login/device), PUT polls it. On success the user-to-server token
// is used once — to list the installations the member can reach — then
// discarded; openfloor keeps storing no GitHub user token. Installations link
// through the same table the redirect callback writes.
//
// Requires GITHUB_APP_CLIENT_ID and "Enable Device Flow" on the GitHub App;
// without the binding both verbs answer 501 so the UI can fall back to the
// install-redirect path. Test mode (OPENFLOOR_TEST_GITHUB_DATA) short-circuits
// GitHub entirely and links the fake installation on the first poll.
import { getGitHubAppConfig } from "@/db";
import { linkUserGitHubInstallation, listUserGitHubInstallations } from "@/db/github-installations";
import { getInstallationAccount } from "@/lib/github";
import { isApiError, requireApiUser } from "@/lib/server-auth";

const GITHUB_ACCEPT = { accept: "application/json", "content-type": "application/json" };
const TEST_DEVICE_CODE = "test-device-code";

export async function POST() {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const config = getGitHubAppConfig();
  if (config.testData) {
    return Response.json({
      deviceCode: TEST_DEVICE_CODE,
      userCode: "TEST-CODE",
      verificationUri: "https://github.com/login/device",
      interval: 1,
      expiresIn: 900,
    });
  }
  if (!config.clientId) {
    return Response.json({ error: "GitHub device flow is not configured" }, { status: 501 });
  }
  const response = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: GITHUB_ACCEPT,
    body: JSON.stringify({ client_id: config.clientId }),
  });
  if (!response.ok) {
    return Response.json({ error: "GitHub did not start the device flow" }, { status: 502 });
  }
  const body = await response.json() as {
    device_code?: string; user_code?: string; verification_uri?: string; interval?: number; expires_in?: number;
  };
  if (!body.device_code || !body.user_code) {
    return Response.json({ error: "GitHub did not start the device flow" }, { status: 502 });
  }
  return Response.json({
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri ?? "https://github.com/login/device",
    interval: body.interval ?? 5,
    expiresIn: body.expires_in ?? 900,
  });
}

export async function PUT(request: Request) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  let body: { deviceCode?: unknown };
  try {
    body = await request.json() as { deviceCode?: unknown };
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const deviceCode = typeof body.deviceCode === "string" ? body.deviceCode : "";
  if (!deviceCode || deviceCode.length > 200) {
    return Response.json({ error: "Device code is required" }, { status: 400 });
  }
  const config = getGitHubAppConfig();

  if (config.testData) {
    if (deviceCode !== TEST_DEVICE_CODE) return Response.json({ error: "Device code is required" }, { status: 400 });
    // Same account resolution as the install-redirect callback — the two
    // connect paths must write the identical fixture identity, or a test
    // that removes and re-adds access sees the account rename itself.
    await linkUserGitHubInstallation(
      user.id,
      config.testData.installationId,
      await getInstallationAccount(config, config.testData.installationId),
    );
    return Response.json({ connected: true, installations: await listUserGitHubInstallations(user.id) });
  }

  if (!config.clientId) {
    return Response.json({ error: "GitHub device flow is not configured" }, { status: 501 });
  }
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: GITHUB_ACCEPT,
    body: JSON.stringify({
      client_id: config.clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  const token = await tokenResponse.json().catch(() => null) as
    { access_token?: string; error?: string; interval?: number } | null;
  if (!token) return Response.json({ error: "GitHub did not answer the poll" }, { status: 502 });
  if (token.error === "authorization_pending") return Response.json({ pending: true });
  if (token.error === "slow_down") return Response.json({ pending: true, interval: token.interval ?? 10 });
  if (token.error === "expired_token") return Response.json({ expired: true });
  if (token.error || !token.access_token) {
    return Response.json({ error: "GitHub declined the authorization" }, { status: 400 });
  }

  // One use, then dropped: list the installations this member can reach, and
  // read the profile so onboarding can prefill the display name. Neither call
  // stores the token.
  const githubHeaders = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token.access_token}`,
    "user-agent": "openfloor",
  };
  const installationsResponse = await fetch("https://api.github.com/user/installations?per_page=100", { headers: githubHeaders });
  if (!installationsResponse.ok) {
    return Response.json({ error: "GitHub installations could not be listed" }, { status: 502 });
  }
  const profileResponse = await fetch("https://api.github.com/user", { headers: githubHeaders });
  const profile = profileResponse.ok
    ? await profileResponse.json().catch(() => null) as { login?: string; name?: string | null } | null
    : null;
  const payload = await installationsResponse.json() as {
    installations?: Array<{ id: number; account?: { login?: string; type?: string } | null }>;
  };
  const found = payload.installations ?? [];
  for (const installation of found) {
    await linkUserGitHubInstallation(user.id, String(installation.id), {
      login: installation.account?.login ?? "unknown",
      type: installation.account?.type ?? "User",
    });
  }
  return Response.json({
    connected: true,
    installed: found.length > 0,
    installations: await listUserGitHubInstallations(user.id),
    githubUser: profile?.login ? { login: profile.login, name: profile.name ?? null } : null,
  });
}
