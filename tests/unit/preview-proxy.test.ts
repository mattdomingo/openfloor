import { describe, expect, it } from "vitest";
import { isPreviewHostname, previewFrameAncestor, rewritePreviewResponse, stripAccessCredentials } from "../../lib/preview-proxy";

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
    const upstream = new Response("redirecting", {
      status: 302,
      headers: {
        location: "/login",
        "x-frame-options": "DENY",
        "content-security-policy": "default-src 'self'; frame-ancestors 'none'; connect-src 'self' wss:",
      },
    });
    upstream.headers.append("set-cookie", "preview_session=abc; Domain=preview.opnflr.com; Path=/; HttpOnly");
    upstream.headers.append("set-cookie", "theme=dark; Path=/; SameSite=Lax");
    const response = rewritePreviewResponse(upstream, "https://app.opnflr.com");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login");
    expect(response.headers.get("set-cookie")).toContain("preview_session=abc");
    expect(response.headers.get("set-cookie")).toContain("theme=dark");
    expect(response.headers.get("set-cookie")).not.toContain("Domain=");
    expect(response.headers.get("x-frame-options")).toBeNull();
    expect(response.headers.get("content-security-policy")).toBe("default-src 'self'; connect-src 'self' wss:; frame-ancestors https://app.opnflr.com");
    expect(await response.text()).toBe("redirecting");
  });

  it("accepts only generated subdomains of configured preview host", () => {
    expect(isPreviewHostname("8080-id.preview.opnflr.com", "preview.opnflr.com")).toBe(true);
    expect(isPreviewHostname("preview.opnflr.com", "preview.opnflr.com")).toBe(false);
    expect(isPreviewHostname("preview.opnflr.com.attacker.test", "preview.opnflr.com")).toBe(false);
  });

  it("derives framing only from a valid environment runtime origin", () => {
    expect(previewFrameAncestor("https://dev.app.opnflr.com")).toBe("https://dev.app.opnflr.com");
    expect(previewFrameAncestor("http://localhost:3000")).toBe("http://localhost:3000");
    expect(previewFrameAncestor("http://app.opnflr.com")).toBeNull();
    expect(previewFrameAncestor("https://app.opnflr.com/path")).toBeNull();
  });

  it("supports loopback framing during local preview development", () => {
    const response = rewritePreviewResponse(new Response("ok"), "http://localhost:* http://127.0.0.1:*");
    expect(response.headers.get("content-security-policy"))
      .toBe("frame-ancestors http://localhost:* http://127.0.0.1:*");
  });
});
