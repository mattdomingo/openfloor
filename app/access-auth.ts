import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  identityFromTrustedHeaders,
  type AuthenticatedIdentity,
} from "@/lib/identity";
import { accessRequiredPath, accessSignInPath, earlyAccessPath, protectedAccessPath, safeAppReturnPath } from "@/lib/access-paths";

export type AccessUser = AuthenticatedIdentity;

export async function getAccessUser(): Promise<AccessUser | null> {
  const requestHeaders = await headers();
  return identityFromTrustedHeaders(requestHeaders);
}

export async function requireAccessUser(returnTo: string): Promise<AccessUser> {
  const user = await getAccessUser();
  if (user) return user;
  redirect(accessRequiredPath(returnTo));
}

// The pure path helpers live in lib/access-paths.ts — this file re-exports
// them so existing importers (app/page.tsx, app/onboarding/page.tsx, the
// billing/onboarding API routes) are unaffected. Anything that only needs
// these, with no Next request context (a plain route handler, a worker
// test), should import lib/access-paths.ts directly instead: importing
// anything from this file also imports next/navigation's `redirect`, which
// fails outside a real Next-rendered request.
export { accessSignInPath, earlyAccessPath, protectedAccessPath, safeAppReturnPath };
