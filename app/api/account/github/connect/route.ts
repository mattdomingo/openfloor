import { BASE_PATH } from "@/components/basePath";
import { getGitHubAppConfig } from "@/db";
import { createGitHubAccountConnectionState, type GitHubAccountConnectionPurpose } from "@/db/github-installations";
import { githubInstallationUrl } from "@/lib/github";
import { signGitHubStateId } from "@/lib/github-state";
import { safeAppReturnPath } from "@/lib/access-paths";
import { isApiError, requireApiUser } from "@/lib/server-auth";

export async function POST(request: Request) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  let body: { purpose?: unknown; returnTo?: unknown };
  try {
    body = await request.json() as { purpose?: unknown; returnTo?: unknown };
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const purpose: GitHubAccountConnectionPurpose | null = body.purpose === "onboarding"
    ? "onboarding"
    : body.purpose === "settings" ? "settings" : null;
  if (!purpose) return Response.json({ error: "GitHub connection purpose is invalid" }, { status: 400 });
  const returnTo = purpose === "onboarding"
    ? safeAppReturnPath(body.returnTo) ?? `${BASE_PATH}/home`
    : safeAppReturnPath(body.returnTo) ?? `${BASE_PATH}/home/settings?section=connections`;
  const config = getGitHubAppConfig();
  const stateId = await createGitHubAccountConnectionState(user.id, purpose, returnTo);
  const state = await signGitHubStateId(stateId, config.stateSecret);
  return Response.json({ installUrl: githubInstallationUrl(config, state) });
}
