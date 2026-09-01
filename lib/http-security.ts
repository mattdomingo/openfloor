import { BASE_PATH } from "@/components/basePath";

export function violatesBrowserMutationPolicy(request: Request, url = new URL(request.url)): boolean {
  const protectedMutation = url.pathname.startsWith(`${BASE_PATH}/api/`)
    || url.pathname === `${BASE_PATH}/early-access/waitlist`
    || url.pathname === `${BASE_PATH}/early-access/unlock`;
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method) || !protectedMutation) return false;
  if (request.headers.get("sec-fetch-site") === "cross-site") return true;
  const origin = request.headers.get("origin");
  return origin !== null && origin !== url.origin;
}

export function withSecurityHeaders(response: Response, url: URL): Response {
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Content-Security-Policy", "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (url.protocol === "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    headers.set("Strict-Transport-Security", "max-age=31536000");
  }
  if (!headers.has("Cache-Control") && (
    url.pathname.startsWith(`${BASE_PATH}/api/`)
    || url.pathname.startsWith(`${BASE_PATH}/runtime/`)
    || url.pathname.startsWith(`${BASE_PATH}/signin`)
    || url.pathname.startsWith(`${BASE_PATH}/signout`)
    || url.pathname.startsWith(`${BASE_PATH}/onboarding`)
    || url.pathname.startsWith(`${BASE_PATH}/early-access`)
  )) headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
