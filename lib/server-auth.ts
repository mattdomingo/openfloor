import { redirect } from "next/navigation";
import { getAccessUser, requireAccessUser } from "@/app/access-auth";
import { BASE_PATH } from "@/components/basePath";
import { upsertUser } from "@/db/sessions";
import type { AppUser } from "@/lib/session-types";

export async function getCurrentAppUser(): Promise<AppUser | null> {
  const identity = await getAccessUser();
  return identity ? upsertUser(identity) : null;
}

// Gates a page behind completed onboarding. Only used for page loads
// (app/home, app/session/[id], the join-invite page) — API routes keep using
// requireApiUser unchanged so an in-flight request never breaks mid-call.
// `returnTo` is a caller-supplied relative path (e.g. "/home"), not a
// browser-supplied value, so it doesn't need the query-param validation that
// safeAppReturnPath does for round-tripped redirects.
export async function requireOnboardedUser(returnTo: string): Promise<AppUser> {
  const identity = await requireAccessUser(returnTo);
  const user = await upsertUser(identity);
  if (user.onboardedAt == null) {
    const appReturnTo = `${BASE_PATH}${returnTo === "/" ? "" : returnTo}` || "/";
    redirect(`${BASE_PATH}/onboarding?return_to=${encodeURIComponent(appReturnTo)}`);
  }
  return user;
}

export async function requireApiUser(): Promise<AppUser | Response> {
  const user = await getCurrentAppUser();
  return user ?? Response.json({ error: "Authentication required" }, { status: 401 });
}

export function isApiError(value: AppUser | Response): value is Response {
  return value instanceof Response;
}
