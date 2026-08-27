import { safeAppReturnPath } from "@/app/access-auth";
import { BASE_PATH } from "@/components/basePath";
import { getInviteSigningSecret } from "@/db";
import { getInvitePreview } from "@/db/sessions";
import { verifyInviteToken } from "./invites";

export type OnboardingStep = 1 | 2 | 3 | 4;

// The URL is the only thing a refresh can read back — `github=connected` is
// a one-shot flag set by the GitHub OAuth redirect, not a durable record of
// where onboarding was left off. Without this, reloading mid-flow (e.g. a
// slow provider-key verification on step 3 that looks stuck) silently drops
// the user all the way back to step 1, even though profile/GitHub/keys
// already saved are all still intact server-side.
export function parseOnboardingStep(value: string | undefined): OnboardingStep | null {
  return value === "1" || value === "2" || value === "3" || value === "4" ? (Number(value) as OnboardingStep) : null;
}

export async function validInviteOnboardingReturn(value: unknown): Promise<string | null> {
  const returnTo = safeAppReturnPath(value);
  if (!returnTo) return null;
  const url = new URL(returnTo, "https://app.local");
  const localPath = BASE_PATH && url.pathname.startsWith(BASE_PATH) ? url.pathname.slice(BASE_PATH.length) : url.pathname;
  const match = /^\/join\/([^/]+)$/.exec(localPath);
  if (!match) return null;
  let token: string;
  try {
    token = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  const inviteId = await verifyInviteToken(token, getInviteSigningSecret());
  return inviteId && await getInvitePreview(inviteId) ? returnTo : null;
}

