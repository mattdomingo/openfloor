import { describe, expect, it } from "vitest";
import { rewritePreviewResponse, stripAccessCredentials } from "../../lib/preview-proxy";

describe("preview proxy trust boundary", () => {
  it("strips all Access headers and only the Access cookie", () => {
    const headers = stripAccessCredentials(new Headers({
      "cf-access-jwt-assertion": "jwt",
      "CF-Access-Authenticated-User-Email": "member@example.com",
      cookie: "session=app; CF_Authorization=secret; theme=dark",
      "x-app-header": "kept",
    }));
    expect(headers.get("cf-access-jwt-assertion")).toBeNull();
    expect(headers.get("cf-access-authenticated-user-email")).toBeNull();
    expect(headers.get("cookie")).toBe("session=app; theme=dark");
    expect(headers.get("x-app-header")).toBe("kept");
  });

  it("replaces framing policy while preserving status, redirects, cookies, and other CSP", async () => {
    const response = rewritePreviewResponse(new Response("redirecting", {
      status: 302,
      headers: {
        location: "/login",
        "set-cookie": "preview_session=abc; Path=/; HttpOnly",
        "x-frame-options": "DENY",
        "content-security-policy": "default-src 'self'; frame-ancestors 'none'; connect-src 'self' wss:",
      },
    }));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login");
    expect(response.headers.get("set-cookie")).toContain("preview_session=abc");
    expect(response.headers.get("x-frame-options")).toBeNull();
    expect(response.headers.get("content-security-policy")).toBe("default-src 'self'; connect-src 'self' wss:; frame-ancestors https://app.opnflr.com");
    expect(await response.text()).toBe("redirecting");
  });

  it("supports loopback framing during local preview development", () => {
    const response = rewritePreviewResponse(new Response("ok"), "http://localhost:* http://127.0.0.1:*");
    expect(response.headers.get("content-security-policy"))
      .toBe("frame-ancestors http://localhost:* http://127.0.0.1:*");
  });
});
