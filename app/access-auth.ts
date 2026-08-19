import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { BASE_PATH } from "@/components/basePath";
import {
  identityFromTrustedHeaders,
  type AuthenticatedIdentity,
} from "@/lib/identity";

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

// Navigating to a protected path causes Cloudflare Access to begin login while
// preserving the requested URL. There is intentionally no application-owned
// login callback or password flow.
export function accessSignInPath(returnTo: string): string {
  return appPath(safeRelativeReturnPath(returnTo));
}

function accessRequiredPath(returnTo: string): string {
  const landing = appPath("/");
  return `${landing}?auth=required&return_to=${encodeURIComponent(appPath(safeRelativeReturnPath(returnTo)))}`;
}

function appPath(path: string): string {
  return `${BASE_PATH}${path === "/" ? "" : path}` || "/";
}

function safeRelativeReturnPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) return "/home";
  let url: URL;
  try {
    url = new URL(value, "https://app.local");
  } catch {
    return "/home";
  }
  if (url.origin !== "https://app.local") return "/home";
  return `${url.pathname}${url.search}${url.hash}`;
}
