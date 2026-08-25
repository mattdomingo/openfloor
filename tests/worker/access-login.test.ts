import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAccessCodeChallenge, fetchAccessLoginTarget, resolveOwnStylesheetHref } from "@/lib/access-login";

// Lives in tests/worker/, not tests/unit/, because lib/access-login.ts uses
// HTMLRewriter — a Workers-runtime global, unavailable under vitest.unit
// .config.ts's plain Node environment. This config's cloudflareTest pool
// runs real workerd, matching tests/worker/credentials.test.ts's convention
// for other fetch-stubbing worker-native tests.

const TEAM_DOMAIN = "https://openfloor-worker-test.cloudflareaccess.com";

// A stripped-down but structurally faithful copy of Cloudflare's real
// hosted login page markup (captured live against openfloor.cloudflareaccess
// .com during development; every token/JWT/client_id here is fabricated).
function loginPageHtml(actionUrl: string): string {
  return `<!doctype html><html><body>
    <div class="AuthBox">
      <div class="AuthBox-body">
        <h1 class="Card-title">Log in to openfloor</h1>
        <div class="AuthServiceLogin">
          <a class="Button-is-auth js-idp" data-idp="Google" href="https://accounts.google.com/o/oauth2/auth?state=fixture">Google</a>
        </div>
        <form class="AuthFormLogin" action='${actionUrl}'>
          <input id="email" type="email" name="email">
          <input hidden type="text" name="redirect_url" value="">
        </form>
      </div>
    </div>
  </body></html>`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchAccessLoginTarget", () => {
  it("extracts the email form's action from a real fetch", async () => {
    const action = `${TEAM_DOMAIN}/cdn-cgi/access/verify-code/app.opnflr.com?kid=fixture&meta=fixture`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(loginPageHtml(action), { status: 200 })));
    const result = await fetchAccessLoginTarget("https://app.opnflr.com/home", TEAM_DOMAIN);
    expect(result).toEqual({ ok: true, emailAction: action });
  });

  it("extracts from a supplied fixture without touching the network", async () => {
    const action = `${TEAM_DOMAIN}/cdn-cgi/access/verify-code/app.opnflr.com?kid=fixture&meta=fixture`;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await fetchAccessLoginTarget("https://app.opnflr.com/home", TEAM_DOMAIN, {
      testHtml: loginPageHtml(action),
    });
    expect(result).toEqual({ ok: true, emailAction: action });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports unreachable on a non-OK upstream response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    const result = await fetchAccessLoginTarget("https://app.opnflr.com/home", TEAM_DOMAIN);
    expect(result).toEqual({ ok: false, reason: "unreachable" });
  });

  it("reports unreachable when the fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const result = await fetchAccessLoginTarget("https://app.opnflr.com/home", TEAM_DOMAIN);
    expect(result).toEqual({ ok: false, reason: "unreachable" });
  });

  it("reports unrecognized when the markup has no email form", async () => {
    const result = await fetchAccessLoginTarget("https://app.opnflr.com/home", TEAM_DOMAIN, {
      testHtml: "<!doctype html><html><body><p>Unexpected Cloudflare page</p></body></html>",
    });
    expect(result).toEqual({ ok: false, reason: "unrecognized" });
  });

  it("reports unrecognized when the extracted action is off the team domain", async () => {
    const result = await fetchAccessLoginTarget("https://app.opnflr.com/home", TEAM_DOMAIN, {
      testHtml: loginPageHtml("https://attacker.example/steal"),
    });
    expect(result).toEqual({ ok: false, reason: "unrecognized" });
  });

  it("HTML-decodes an entity-encoded action — Cloudflare's real markup encodes this attribute's ampersands", async () => {
    // Regression case: HTMLRewriter's getAttribute() returns raw source
    // text, not entity-decoded (confirmed empirically) — a naive
    // implementation hands `?kid=x&amp;meta=y` straight to fetch(), which
    // parses as a stray "amp;meta" query param instead of "meta".
    const decoded = `${TEAM_DOMAIN}/cdn-cgi/access/verify-code/app.opnflr.com?kid=fixture&meta=fixture`;
    const encoded = `${TEAM_DOMAIN}/cdn-cgi/access/verify-code/app.opnflr.com?kid=fixture&amp;meta=fixture`;
    const result = await fetchAccessLoginTarget("https://app.opnflr.com/home", TEAM_DOMAIN, {
      testHtml: loginPageHtml(encoded),
    });
    expect(result).toEqual({ ok: true, emailAction: decoded });
  });

  it("reports unrecognized when the team domain could not be resolved", async () => {
    const action = `${TEAM_DOMAIN}/cdn-cgi/access/verify-code/app.opnflr.com?kid=fixture&meta=fixture`;
    const result = await fetchAccessLoginTarget("https://app.opnflr.com/home", null, {
      testHtml: loginPageHtml(action),
    });
    expect(result).toEqual({ ok: false, reason: "unrecognized" });
  });
});

describe("fetchAccessCodeChallenge", () => {
  const validAction = `${TEAM_DOMAIN}/cdn-cgi/access/verify-code/app.opnflr.com?kid=fixture&meta=fixture`;

  it("extracts the nonce from a real fetch's redirect", async () => {
    const location = `${TEAM_DOMAIN}/cdn-cgi/access/verify-code/app.opnflr.com?kid=fixture&meta=fixture&nonce=fixture-nonce`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302, headers: { location } })));
    const result = await fetchAccessCodeChallenge(validAction, "person@example.com", TEAM_DOMAIN);
    expect(result).toEqual({ ok: true, nonce: "fixture-nonce", callbackUrl: `${TEAM_DOMAIN}/cdn-cgi/access/callback` });
  });

  it("extracts from a supplied fixture without touching the network", async () => {
    const location = `${TEAM_DOMAIN}/cdn-cgi/access/verify-code/app.opnflr.com?kid=fixture&meta=fixture&nonce=fixture-nonce`;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await fetchAccessCodeChallenge(validAction, "person@example.com", TEAM_DOMAIN, { testLocation: location });
    expect(result).toEqual({ ok: true, nonce: "fixture-nonce", callbackUrl: `${TEAM_DOMAIN}/cdn-cgi/access/callback` });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an action URL off the team domain before making any request — the hidden field is client-controllable", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await fetchAccessCodeChallenge("https://attacker.example/collect", "person@example.com", TEAM_DOMAIN);
    expect(result).toEqual({ ok: false, reason: "unrecognized" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports unreachable when the fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const result = await fetchAccessCodeChallenge(validAction, "person@example.com", TEAM_DOMAIN);
    expect(result).toEqual({ ok: false, reason: "unreachable" });
  });

  it("reports unreachable when the response carries no Location header", async () => {
    const result = await fetchAccessCodeChallenge(validAction, "person@example.com", TEAM_DOMAIN, { testLocation: null });
    expect(result).toEqual({ ok: false, reason: "unreachable" });
  });

  it("reports unrecognized when the Location has no nonce", async () => {
    const location = `${TEAM_DOMAIN}/cdn-cgi/access/verify-code/app.opnflr.com?kid=fixture&meta=fixture`;
    const result = await fetchAccessCodeChallenge(validAction, "person@example.com", TEAM_DOMAIN, { testLocation: location });
    expect(result).toEqual({ ok: false, reason: "unrecognized" });
  });
});

describe("resolveOwnStylesheetHref", () => {
  it("extracts the stylesheet href from a real fetch of the landing page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      '<!doctype html><html><head><link rel="stylesheet" href="/assets/index-fixture.css"></head><body></body></html>',
      { status: 200 },
    )));
    const href = await resolveOwnStylesheetHref("https://app.opnflr.com");
    expect(href).toBe("/assets/index-fixture.css");
  });

  it("extracts from a supplied fixture without touching the network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const href = await resolveOwnStylesheetHref("https://app.opnflr.com", {
      testHtml: '<!doctype html><html><head><link rel="stylesheet" href="/assets/index-fixture.css"></head></html>',
    });
    expect(href).toBe("/assets/index-fixture.css");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("decodes an entity-encoded href the same way the form-action extraction does", async () => {
    const href = await resolveOwnStylesheetHref("https://app.opnflr.com", {
      testHtml: '<link rel="stylesheet" href="/assets/index.css?v=1&amp;cache=2">',
    });
    expect(href).toBe("/assets/index.css?v=1&cache=2");
  });

  it("returns null (degrading to unstyled HTML) when testHtml is explicitly null", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const href = await resolveOwnStylesheetHref("https://app.opnflr.com", { testHtml: null });
    expect(href).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns null when no stylesheet link is present", async () => {
    const href = await resolveOwnStylesheetHref("https://app.opnflr.com", { testHtml: "<html><body>no styles</body></html>" });
    expect(href).toBeNull();
  });

  it("returns null when the fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const href = await resolveOwnStylesheetHref("https://app.opnflr.com");
    expect(href).toBeNull();
  });

  it("returns null on a non-OK response rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    const href = await resolveOwnStylesheetHref("https://app.opnflr.com");
    expect(href).toBeNull();
  });
});
