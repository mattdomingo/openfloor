export function stripAccessCredentials(input: Headers): Headers {
  const headers = new Headers(input);
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith("cf-access-")) headers.delete(name);
  }
  const cookies = (headers.get("cookie") ?? "").split(";")
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie && cookie.slice(0, Math.max(0, cookie.indexOf("="))).trim().toLowerCase() !== "cf_authorization");
  if (cookies.length) headers.set("cookie", cookies.join("; "));
  else headers.delete("cookie");
  return headers;
}

export function isPreviewHostname(hostname: string, configuredRoot: string | undefined): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  const root = configuredRoot?.trim().toLowerCase().replace(/\.$/, "");
  if (!root || !/^[a-z0-9.-]+$/.test(root) || host === root) return false;
  return host.endsWith(`.${root}`);
}

export function previewFrameAncestor(runtimeOrigin: string | undefined): string | null {
  if (!runtimeOrigin) return null;
  try {
    const url = new URL(runtimeOrigin);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function rewritePreviewResponse(response: Response, frameAncestor: string): Response {
  // A 101 response carries a live WebSocket and cannot be reconstructed.
  if (response.status === 101 || (response as Response & { webSocket?: WebSocket }).webSocket) return response;
  const headers = new Headers(response.headers);
  headers.delete("x-frame-options");
  const cookies = headers.getSetCookie();
  if (cookies.length) {
    headers.delete("set-cookie");
    for (const cookie of cookies) {
      // Candidate apps keep cookies, but each generated hostname gets a
      // host-only jar. A repository must not set parent-domain cookies that
      // would cross into another session's preview hostname.
      headers.append("set-cookie", cookie.split(";")
        .filter((part) => !/^\s*domain\s*=/i.test(part))
        .join(";"));
    }
  }
  const directives = (headers.get("content-security-policy") ?? "").split(";")
    .map((value) => value.trim()).filter(Boolean)
    .filter((value) => !value.toLowerCase().startsWith("frame-ancestors"));
  directives.push(`frame-ancestors ${frameAncestor}`);
  headers.set("content-security-policy", directives.join("; "));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
