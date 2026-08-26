import { getSessionForMember } from "@/db/sessions";

export type SettingsOrigin = { href: string; label: string };

const SESSIONS: SettingsOrigin = { href: "/home", label: "Sessions" };
const SESSION_PATH = /^\/session\/([A-Za-z0-9_-]{1,64})(\/floor)?$/;

// Resolves the AppHeader back-link for /settings. `from` is browser-supplied
// (the ?from= query param), so unlike lib/server-auth.ts:requireOnboardedUser's
// caller-supplied `returnTo` this needs real validation — but the set of
// legal origins is small and known (home, or a session the user belongs to),
// so a shape allowlist checked against membership is simpler and safer than
// the general-purpose same-origin check in app/access-auth.ts:safeAppReturnPath,
// which would accept any internal path and can't supply a label.
// Falls back to Sessions/home for anything unrecognized: absent param, a
// direct link, a bookmark, a Stripe return with no `from`, or a session the
// caller isn't (or is no longer) a member of. The back control is never
// broken, just occasionally the safe default.
export async function resolveSettingsOrigin(from: unknown, userId: string): Promise<SettingsOrigin> {
  if (typeof from !== "string" || from === "/home") return SESSIONS;
  const match = SESSION_PATH.exec(from);
  if (!match) return SESSIONS;
  const session = await getSessionForMember(match[1], userId);
  if (!session) return SESSIONS;
  return { href: from, label: match[2] ? `${session.title} floor` : session.title };
}
