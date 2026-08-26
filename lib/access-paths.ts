// Pure return-path and Access-path math, split out of app/access-auth.ts so
// it can be imported by plain route handlers (app/signin/code/route.ts) and
// their worker tests without pulling in next/navigation — which fails
// outside a real Next request render (confirmed: importing anything from
// app/access-auth.ts transitively imports `redirect`, and next/navigation's
// module-level state is undefined when loaded directly in a worker test).
// app/access-auth.ts re-exports everything here, so existing importers of
// safeAppReturnPath / accessSignInPath are unaffected.

import { env } from "cloudflare:workers";
import { BASE_PATH } from "@/components/basePath";

// Validate browser-supplied return_to values with URL parsing. Browsers
// normalize `/\\host` into `//host`, so prefix checks alone are unsafe.
export function safeAppReturnPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value, "https://app.local");
  } catch {
    return null;
  }
  if (url.origin !== "https://app.local") return null;
  if (BASE_PATH && url.pathname !== BASE_PATH && !url.pathname.startsWith(`${BASE_PATH}/`)) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

// Navigating to a protected path causes Cloudflare Access to begin login
// while preserving the requested URL. When ACCESS_CUSTOM_LOGIN_ENABLED is on
// (the cast idiom every other wrangler.jsonc rollout gate uses — see
// lib/agent-run-start.ts), this instead sends the browser to /signin, a page
// styled to match the landing that authenticates through this same Access
// application for the email/one-time-code path; there is still no
// application-owned password flow, and Google is untouched by this switch —
// see protectedAccessPath and the 2026-08-25 decision log.
export function accessSignInPath(returnTo: string): string {
  const path = protectedAccessPath(returnTo);
  const bindings = env as unknown as { ACCESS_CUSTOM_LOGIN_ENABLED?: string };
  if (bindings.ACCESS_CUSTOM_LOGIN_ENABLED === "true") {
    return `/signin?return_to=${encodeURIComponent(path)}`;
  }
  return path;
}

// The real Access-protected path for a return target, bypassing /signin
// entirely. /signin itself must use this — never accessSignInPath — for its
// Google link and its upstream-failure fallback, or it would loop back to
// itself whenever the custom page is enabled.
export function protectedAccessPath(returnTo: string): string {
  return appPath(safeRelativeReturnPath(returnTo));
}

export function accessRequiredPath(returnTo: string): string {
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
