import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as postSignInCode } from "@/app/signin/code/route";

// app/signin/code/route.ts is a plain route handler (Request → Response, no
// React), so — unlike app/signin/page.tsx — it can be exercised directly
// here, the same way tests/worker/credentials.test.ts imports the runtime
// gateway routes, rather than only through the render pool's SELF.fetch.

const TEAM_DOMAIN = "https://openfloor-worker-test.cloudflareaccess.com";
const VALID_ACTION = `${TEAM_DOMAIN}/cdn-cgi/access/verify-code/app.opnflr.com?kid=fixture&meta=fixture`;

function codeRequest(fields: Record<string, string>, returnTo = "/home"): Request {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return new Request(`https://app.opnflr.com/signin/code?return_to=${encodeURIComponent(returnTo)}`, {
    method: "POST",
    body: form,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (env as unknown as Record<string, unknown>).CF_ACCESS_TEAM_DOMAIN;
  delete (env as unknown as Record<string, unknown>).OPENFLOOR_TEST_ACCESS_LOGIN_LOCATION;
});

describe("POST /signin/code", () => {
  it("renders the code-entry step with the nonce and the user's email, action pointed at Cloudflare's real callback", async () => {
    (env as unknown as Record<string, unknown>).CF_ACCESS_TEAM_DOMAIN = TEAM_DOMAIN;
    (env as unknown as Record<string, unknown>).OPENFLOOR_TEST_ACCESS_LOGIN_LOCATION =
      `${TEAM_DOMAIN}/cdn-cgi/access/verify-code/app.opnflr.com?kid=fixture&meta=fixture&nonce=fixture-nonce`;

    const response = await postSignInCode(codeRequest({ email: "person@example.com", action: VALID_ACTION }));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`action="${TEAM_DOMAIN}/cdn-cgi/access/callback"`);
    expect(html).toContain('value="fixture-nonce"');
    expect(html).toContain("We sent a code to person@example.com.");
    expect(html).toContain('href="/signin?return_to=%2Fhome"');
    // Regression: this page hand-builds a standalone HTML document — an
    // earlier version resolved the app's compiled stylesheet via a
    // same-origin self-fetch, which proved unreliable in production and
    // shipped completely unstyled. Styling is now inlined directly, so this
    // just proves the inline stylesheet is actually present.
    expect(html).toContain("<style>");
    expect(html).toContain(".entry-shell{");
    expect(html).toContain(".signin-input{");
    expect(html).toContain('localStorage.getItem("openfloor:theme")');
    expect(html).toContain(':root[data-theme="light"] .entry-shell');
    expect(html).toContain(':root:not([data-theme]) .entry-shell');
  });

  it("HTML-escapes the submitted email rather than injecting it raw", async () => {
    (env as unknown as Record<string, unknown>).CF_ACCESS_TEAM_DOMAIN = TEAM_DOMAIN;
    (env as unknown as Record<string, unknown>).OPENFLOOR_TEST_ACCESS_LOGIN_LOCATION =
      `${TEAM_DOMAIN}/cdn-cgi/access/verify-code/app.opnflr.com?nonce=fixture-nonce`;

    const response = await postSignInCode(codeRequest({ email: '"><script>alert(1)</script>@example.com', action: VALID_ACTION }));
    const html = await response.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("falls back to the real protected path when the action field is off the team domain", async () => {
    (env as unknown as Record<string, unknown>).CF_ACCESS_TEAM_DOMAIN = TEAM_DOMAIN;
    const response = await postSignInCode(
      codeRequest({ email: "person@example.com", action: "https://attacker.example/collect" }, "/session/private-room"),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/session/private-room");
  });

  it("falls back to the real protected path when the upstream never returns a usable nonce", async () => {
    (env as unknown as Record<string, unknown>).CF_ACCESS_TEAM_DOMAIN = TEAM_DOMAIN;
    (env as unknown as Record<string, unknown>).OPENFLOOR_TEST_ACCESS_LOGIN_LOCATION = null;
    const response = await postSignInCode(codeRequest({ email: "person@example.com", action: VALID_ACTION }));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/home");
  });

  it("falls back to the real protected path when the email or action field is missing", async () => {
    (env as unknown as Record<string, unknown>).CF_ACCESS_TEAM_DOMAIN = TEAM_DOMAIN;
    const response = await postSignInCode(codeRequest({ email: "person@example.com" }));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/home");
  });

  it("falls back rather than erroring when CF_ACCESS_TEAM_DOMAIN is unset", async () => {
    const response = await postSignInCode(codeRequest({ email: "person@example.com", action: VALID_ACTION }));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/home");
  });

  it("rejects a browser-normalized external return_to the same way the landing page does", async () => {
    (env as unknown as Record<string, unknown>).CF_ACCESS_TEAM_DOMAIN = TEAM_DOMAIN;
    (env as unknown as Record<string, unknown>).OPENFLOOR_TEST_ACCESS_LOGIN_LOCATION =
      `${TEAM_DOMAIN}/cdn-cgi/access/verify-code/app.opnflr.com?nonce=fixture-nonce`;
    const response = await postSignInCode(codeRequest({ email: "person@example.com", action: VALID_ACTION }, "/\\evil.example/phish"));
    const html = await response.text();
    expect(html).toContain('href="/signin?return_to=%2Fhome"');
    expect(html).not.toContain("evil.example");
  });
});
