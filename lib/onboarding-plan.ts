import { safeAppReturnPath } from "@/app/access-auth";
import { BASE_PATH } from "@/components/basePath";
import { getInviteSigningSecret } from "@/db";
import { getInvitePreview } from "@/db/sessions";
import { verifyInviteToken } from "./invites";

// Two steps: profile + GitHub, then AI connections. The plan step is hidden
// for now — every signup is enrolled on Free (the client always posts
// plan=free) until plan selection returns.
export type OnboardingStep = 1 | 2;

// The URL is the only thing a refresh can read back. Without this, reloading
// mid-flow (e.g. a slow provider-key verification on step 2 that looks
// stuck) silently drops the user back to step 1, even though profile/GitHub/
// keys already saved are all still intact server-side.
export function parseOnboardingStep(value: string | undefined): OnboardingStep | null {
  return value === "1" || value === "2" ? (Number(value) as OnboardingStep) : null;
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

