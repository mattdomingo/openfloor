import { describe, expect, it } from "vitest";
import { violatesBrowserMutationPolicy, withSecurityHeaders } from "@/lib/http-security";

describe("HTTP security boundary", () => {
  it("rejects cross-site browser API mutations but permits same-origin and headerless clients", () => {
    expect(violatesBrowserMutationPolicy(new Request("https://app.opnflr.com/api/sessions/x", {
      method: "POST", headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    }))).toBe(true);
    expect(violatesBrowserMutationPolicy(new Request("https://app.opnflr.com/api/sessions/x", {
      method: "PATCH", headers: { origin: "https://app.opnflr.com", "sec-fetch-site": "same-origin" },
    }))).toBe(false);
    expect(violatesBrowserMutationPolicy(new Request("https://app.opnflr.com/api/sessions/x", { method: "DELETE" }))).toBe(false);
    expect(violatesBrowserMutationPolicy(new Request("https://app.opnflr.com/webhooks/github", {
      method: "POST", headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    }))).toBe(false);
  });

  it("sets browser headers and no-store without overriding explicit caching", () => {
    const hardened = withSecurityHeaders(new Response("ok"), new URL("https://app.opnflr.com/api/account"));
    expect(hardened.headers.get("x-content-type-options")).toBe("nosniff");
    expect(hardened.headers.get("x-frame-options")).toBe("DENY");
    expect(hardened.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(hardened.headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect(hardened.headers.get("cache-control")).toBe("no-store");

    const cached = withSecurityHeaders(new Response("ok", { headers: { "cache-control": "private, max-age=60" } }), new URL("https://app.opnflr.com/api/account/avatar/u"));
    expect(cached.headers.get("cache-control")).toBe("private, max-age=60");
  });
});
