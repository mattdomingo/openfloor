export function stripAccessCredentials(input: Headers): Headers {
  const headers = new Headers(input);
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith("cf-access-")) headers.delete(name);
  }
  const cookies = (headers.get("cookie") ?? "").split(";")
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie && cookie.split("=", 1)[0].toLowerCase() !== "cf_authorization");
  if (cookies.length) headers.set("cookie", cookies.join("; "));
  else headers.delete("cookie");
  return headers;
}

export function rewritePreviewResponse(
  response: Response,
  frameAncestors = "https://app.opnflr.com",
): Response {
  // Cloudflare's 101 response carries a live WebSocket handle and cannot be
  // reconstructed by standards-compliant Response implementations.
  if (response.status === 101 || (response as Response & { webSocket?: WebSocket }).webSocket) return response;
  const headers = new Headers(response.headers);
  headers.delete("x-frame-options");
  const directives = (headers.get("content-security-policy") ?? "").split(";")
    .map((value) => value.trim()).filter(Boolean)
    .filter((value) => !value.toLowerCase().startsWith("frame-ancestors"));
  directives.push(`frame-ancestors ${frameAncestors}`);
  headers.set("content-security-policy", directives.join("; "));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
