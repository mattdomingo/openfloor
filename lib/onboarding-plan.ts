import { safeAppReturnPath } from "@/app/access-auth";
import { BASE_PATH } from "@/components/basePath";
import { getInviteSigningSecret } from "@/db";
import { getInvitePreview } from "@/db/sessions";
import { verifyInviteToken } from "./invites";

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

