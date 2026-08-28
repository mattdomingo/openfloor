import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { accessSignInPath, protectedAccessPath } from "@/lib/access-paths";

// accessSignInPath imports `env` from cloudflare:workers, so — like
// app/signin/code/route.ts — it needs the Workers runtime and lives here
// rather than in tests/unit/.

afterEach(() => {
  delete (env as unknown as Record<string, unknown>).ACCESS_CUSTOM_LOGIN_ENABLED;
});

describe("accessSignInPath", () => {
  it("points at the Access-protected anchor when the custom sign-in page is disabled (the default)", () => {
    expect(accessSignInPath("/home")).toBe("/auth/complete?return_to=%2Fhome");
    expect(accessSignInPath("/session/private-room")).toBe("/auth/complete?return_to=%2Fsession%2Fprivate-room");
  });

  it("points at /signin, carrying the protected path as return_to, when enabled", () => {
    (env as unknown as Record<string, unknown>).ACCESS_CUSTOM_LOGIN_ENABLED = "true";
    expect(accessSignInPath("/home")).toBe("/signin?return_to=%2Fhome");
    expect(accessSignInPath("/session/private-room")).toBe("/signin?return_to=%2Fsession%2Fprivate-room");
  });

  it("normalizes an unsafe or missing return target to /home in both states", () => {
    expect(accessSignInPath("not-a-path")).toBe("/auth/complete?return_to=%2Fhome");
    (env as unknown as Record<string, unknown>).ACCESS_CUSTOM_LOGIN_ENABLED = "true";
    expect(accessSignInPath("not-a-path")).toBe("/signin?return_to=%2Fhome");
  });
});

describe("protectedAccessPath", () => {
  it("anchors on /auth/complete — the one page path Access still protects — carrying the target, ignoring the flag", () => {
    (env as unknown as Record<string, unknown>).ACCESS_CUSTOM_LOGIN_ENABLED = "true";
    expect(protectedAccessPath("/session/private-room")).toBe("/auth/complete?return_to=%2Fsession%2Fprivate-room");
  });
});
