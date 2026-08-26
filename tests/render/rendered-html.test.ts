import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { completeTestOnboarding, testRepositorySelection } from "./github-fixture";

const BASE_PATH = "";

function fetchPath(path: string) {
  return SELF.fetch(`http://localhost${path}`, { headers: { accept: "text/html" }, redirect: "manual" });
}

function render(path = "/") {
  return fetchPath(path === "/" ? BASE_PATH : `${BASE_PATH}${path}`);
}

const authenticatedHeaders = {
  accept: "text/html",
  host: "localhost",
  "x-openfloor-dev-user-id": "render-owner",
  "x-openfloor-dev-user-email": "render@example.com",
  "x-openfloor-dev-user-name": "Render Owner",
};

describe("server rendering", () => {
  it("renders the public openfloor landing page without demo auth", async () => {
    const response = await render();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/html\b/i);

    const html = await response.text();
    expect(html).toMatch(/<title>openfloor — Multiplayer agent development<\/title>/i);
    expect(html).toContain('aria-label="Sign in"');
    expect(html).not.toMatch(/Register|Guest|Session code|type="password"|mock/i);
    expect(html).not.toContain("signin-with-chatgpt");
  });

  it("explains the sign-in bounce and points the CTA back at the requested page", async () => {
    const response = await fetchPath(`${BASE_PATH}?auth=required&return_to=${encodeURIComponent("/session/private-room")}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Sign in to continue. You will be sent back to what you were opening.");
    expect(html).toContain('href="/session/private-room"');
    // Without the params the landing stays quiet.
    const plain = await (await render()).text();
    expect(plain).not.toContain("Sign in to open that page");
  });

  it("rejects browser-normalized external return URLs", async () => {
    const response = await fetchPath(`${BASE_PATH}?return_to=${encodeURIComponent("/\\evil.example/phish")}`);
    const html = await response.text();
    // safeAppReturnPath rejects the tampered value, so the CTA falls back to
    // accessSignInPath("/home") — which, with this pool's
    // ACCESS_CUSTOM_LOGIN_ENABLED, routes through /signin rather than the
    // protected path directly (see the "custom sign-in" describe block).
    expect(html).toContain(`href="${BASE_PATH}/signin?return_to=%2Fhome"`);
    expect(html).not.toMatch(/<a[^>]+href="\/\\evil\.example\/phish"/i);
  });

  it("redirects every protected page to the public landing page", async () => {
    for (const path of ["/home", "/home/settings", "/session/private-room", "/session/private-room/floor", "/join/not-a-token"]) {
      const response = await render(path);
      expect(response.status).toBeGreaterThanOrEqual(300);
      expect(response.status).toBeLessThan(400);
      expect(response.headers.get("location")).toContain("/?auth=required&return_to=%2F");
    }
  });

  it("emits product social metadata from the request origin", async () => {
    const html = await (await render()).text();
    expect(html).toContain('property="og:title" content="openfloor"');
    expect(html).toContain('property="og:image" content="http://localhost:3000/og-v3.png"');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
  });

  it("renders an authenticated floor with no seeded product data", async () => {
    await completeTestOnboarding(authenticatedHeaders, "Render", "Owner");

    const created = await SELF.fetch("http://localhost/api/sessions", {
      method: "POST",
      headers: { ...authenticatedHeaders, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ title: "Empty floor", ...await testRepositorySelection(authenticatedHeaders) }),
    });
    expect(created.status).toBe(201);
    const { session } = await created.json() as { session: { id: string } };
    const owner = await env.DB.prepare("SELECT id FROM users WHERE chatgpt_user_id = ?")
      .bind("render-owner").first<{ id: string }>();
    if (!owner) throw new Error("Render owner was not persisted");
    const now = Date.now();
    const response = await SELF.fetch(`http://localhost/session/${session.id}/floor`, { headers: authenticatedHeaders });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("No agents yet");
    expect(html).toContain('class="chip auto-agent-toggle" data-selected="true" aria-pressed="true"');
    expect(html).toContain("New agent");
    expect(html).toContain("No prompts waiting");
    expect(html).toContain("Teammate drafts");
    expect(html).toContain("Everyone");
    expect(html).toContain("Typing");
    expect(html).toContain("Hidden");
    expect(html).not.toMatch(/Atlas|Nova|Sentry|Proof|OpenMind|server\/session\/reducer/i);

    const generatedId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO floor_agents
         (id, session_id, created_by, owner_user_id, name, name_key, role, task, state, provider, kind, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'Auto Worker', 'auto worker', 'Auto-provisioned engineer', 'Implement real work', 'created', 'openai', 'worker', ?, ?)`,
    ).bind(generatedId, session.id, owner.id, owner.id, now, now).run();
    const generatedHtml = await (await SELF.fetch(`http://localhost/session/${session.id}/floor`, { headers: authenticatedHeaders })).text();
    expect(generatedHtml).toContain("Auto-generated");
    expect(generatedHtml).toContain('aria-label="Auto Worker, auto-generated"');
    expect(generatedHtml).toContain("New agent");

    await env.DB.prepare("UPDATE floor_agents SET deprovisioned_at = ? WHERE id = ?").bind(Date.now(), generatedId).run();
    const retiredHtml = await (await SELF.fetch(`http://localhost/session/${session.id}/floor`, { headers: authenticatedHeaders })).text();
    expect(retiredHtml).not.toContain('aria-label="Auto Worker, auto-generated"');
  });
});

async function onboardedUser(providerUserId: string, firstName: string, lastName: string, email = `${providerUserId}@example.com`) {
  const headers = {
    accept: "text/html",
    host: "localhost",
    "x-openfloor-dev-user-id": providerUserId,
    "x-openfloor-dev-user-email": email,
    "x-openfloor-dev-user-name": `${firstName} ${lastName}`,
  };
  await completeTestOnboarding(headers, firstName, lastName);
  const row = await env.DB.prepare("SELECT id FROM users WHERE chatgpt_user_id = ?").bind(providerUserId).first<{ id: string }>();
  if (!row) throw new Error("Onboarded user was not persisted");
  return { userId: row.id, headers };
}

describe("session lobby setup rendering", () => {
  it("opens a ready lobby without the retired setup dialog", async () => {
    const owner = await onboardedUser("setup-render-owner", "Setup", "Owner");
    const created = await SELF.fetch("http://localhost/api/sessions", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ title: "Setup rendering", objective: "Prepare the floor", ...await testRepositorySelection(owner.headers) }),
    });
    expect(created.status).toBe(201);
    const { session } = await created.json() as { session: { id: string } };

    const setupHtml = await (await SELF.fetch(`http://localhost/session/${session.id}?setup=1`, { headers: owner.headers })).text();
    expect(setupHtml).toContain("Floor ready");
    expect(setupHtml).not.toContain("Session setup · Step");

    const gateHtml = await (await SELF.fetch(`http://localhost/session/${session.id}?repo=required&setup=1`, { headers: owner.headers })).text();
    expect(gateHtml).toContain("Floor ready");
    expect(gateHtml).not.toContain("Session setup · Step");

    const member = await onboardedUser("setup-render-member", "Setup", "Member");
    await env.DB.prepare("INSERT INTO session_members (session_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)")
      .bind(session.id, member.userId, Date.now()).run();
    const memberHtml = await (await SELF.fetch(`http://localhost/session/${session.id}?setup=1`, { headers: member.headers })).text();
    expect(memberHtml).not.toContain("Session setup · Step");
    expect(memberHtml).toContain("Member access");
  });
});

// Reproduces the reported bug end to end: a returning user whose second
// login used a different method (simulated here by a different dev-identity
// provider id) and a differently-cased but identical email must land on the
// same account — and therefore the same session — as their first login,
// not a fresh membership-less one that 404s. onboardedUser's headers path
// through worker/index.ts's identity resolution exactly like a real
// Cloudflare Access login would.
describe("returning through a different login method", () => {
  it("resolves a same-email, different-case, different-provider login to the account holding the session", async () => {
    const owner = await onboardedUser("otp-login-owner", "Otp", "Owner", "dup-login@example.com");
    const created = await SELF.fetch("http://localhost/api/sessions", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ title: "Reopened by Google", ...await testRepositorySelection(owner.headers) }),
    });
    expect(created.status).toBe(201);
    const { session } = await created.json() as { session: { id: string } };

    const googleHeaders = {
      accept: "text/html",
      host: "localhost",
      "x-openfloor-dev-user-id": "google-login-owner",
      "x-openfloor-dev-user-email": "Dup-Login@Example.com",
      "x-openfloor-dev-user-name": "Otp Owner",
    };

    const sessionPage = await SELF.fetch(`http://localhost/session/${session.id}`, { headers: googleHeaders });
    expect(sessionPage.status).toBe(200);
    expect(await sessionPage.text()).toContain("Reopened by Google");

    const floorPage = await SELF.fetch(`http://localhost/session/${session.id}/floor`, { headers: googleHeaders });
    expect(floorPage.status).toBe(200);

    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE email = ?").bind("dup-login@example.com").first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("still 404s for a genuine non-member with a different email", async () => {
    const owner = await onboardedUser("real-owner", "Real", "Owner", "real-owner@example.com");
    const created = await SELF.fetch("http://localhost/api/sessions", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ title: "Not shared", ...await testRepositorySelection(owner.headers) }),
    });
    const { session } = await created.json() as { session: { id: string } };

    const outsider = await onboardedUser("real-outsider", "Real", "Outsider", "real-outsider@example.com");
    const response = await SELF.fetch(`http://localhost/session/${session.id}`, { headers: outsider.headers });
    expect(response.status).toBe(404);
  });

  it("404s for a session id that does not exist", async () => {
    const owner = await onboardedUser("missing-session-user", "Missing", "User", "missing-session@example.com");
    const response = await SELF.fetch("http://localhost/session/does-not-exist", { headers: owner.headers });
    expect(response.status).toBe(404);
  });
});

describe("plan-limits UI", () => {
  it("a new user's /home shows the free-tier copy", async () => {
    const { headers } = await onboardedUser("plan-free-user", "Free", "User");
    const response = await SELF.fetch("http://localhost/home", { headers });
    expect(response.status).toBe(200);
    const html = await response.text();
    // Plan/quota detail now lives behind the Usage tab (HomeScreen.tsx
    // ShopTabs) rather than in always-rendered prose — the tab's own label
    // (remaining%, not used%) is what a plain GET can see without a click.
    expect(html).toContain("Usage (100%)");
  });

  it("seeding usage_months to the cap renders the exhausted notice and the upgrade link", async () => {
    const { userId, headers } = await onboardedUser("plan-exhausted-user", "Exhausted", "User");
    const month = new Date().toISOString().slice(0, 7); // UTC "YYYY-MM", matching lib/plans.ts:currentMonth
    await env.DB.prepare("INSERT INTO usage_months (owner_user_id, month, seconds) VALUES (?, ?, ?)")
      .bind(userId, month, 2 * 3600)
      .run();
    const response = await SELF.fetch("http://localhost/home", { headers });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("2h of monthly session time is used up");
    expect(html).toContain('href="/home/settings?section=plan"');
    expect(html).not.toContain("buy.stripe.com");
  });

  it("POST /api/sessions returns 403 with code quota_exhausted once the free cap is spent", async () => {
    const { userId, headers } = await onboardedUser("plan-exhausted-api-user", "ExhaustedApi", "User");
    const month = new Date().toISOString().slice(0, 7);
    await env.DB.prepare("INSERT INTO usage_months (owner_user_id, month, seconds) VALUES (?, ?, ?)")
      .bind(userId, month, 2 * 3600)
      .run();
    const response = await SELF.fetch("http://localhost/api/sessions", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ title: "Should be refused", ...await testRepositorySelection(headers) }),
    });
    expect(response.status).toBe(403);
    const body = await response.json() as { error?: string; code?: string };
    expect(body.code).toBe("quota_exhausted");
  });

  it("an enterprise, active user renders the unlimited copy without crashing", async () => {
    const { userId, headers } = await onboardedUser("plan-enterprise-user", "Enterprise", "User");
    await env.DB.prepare("UPDATE users SET plan = 'enterprise', plan_status = 'active' WHERE id = ?").bind(userId).run();
    const response = await SELF.fetch("http://localhost/home", { headers });
    expect(response.status).toBe(200);
    const html = await response.text();
    // Unlimited plans show the Usage tab with no percent (usageRemainingPercent
    // is null for Infinity-hour plans) rather than a crash.
    expect(html).toContain(">Usage<");
    expect(html).not.toContain("of undefinedh");
    expect(html).not.toContain("NaN");
  });
});

describe("settings page", () => {
  it("an onboarded user's /home/settings renders their profile tab and ships usage data for the plan tab", async () => {
    const { headers } = await onboardedUser("settings-user", "Settings", "User");
    const response = await SELF.fetch("http://localhost/home/settings", { headers });
    expect(response.status).toBe(200);
    const html = await response.text();
    // The Profile rail section renders server-side by default.
    expect(html).toContain("settings-user@example.com");
    expect(html).toContain("Managed by your sign-in provider");
    // "Plan & usage" only renders once selected client-side, but its data
    // must reach the client in the initial RSC payload (a JS string literal,
    // hence the escaped quotes) for that to work.
    expect(html).toContain('\\"effectivePlan\\":\\"free\\"');
    expect(html).toContain('\\"limitHours\\":2');
  });

  it("renders self-serve Pro, Max, and Enterprise billing from the Plan tab", async () => {
    const { headers } = await onboardedUser("billing-settings-user", "Billing", "User");
    const response = await SELF.fetch("http://localhost/home/settings?section=plan", { headers });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("$30/seat/month");
    expect(html).toContain("$50/seat/month");
    expect(html).toContain("Paid plans");
    expect(html).toContain("Contact sales");
    expect(html).not.toContain("activated manually");
    expect(html).not.toContain("buy.stripe.com");
  });

  it("returns to a member-visible settings origin and conceals other sessions", async () => {
    const owner = await onboardedUser("settings-origin-owner", "Origin", "Owner");
    const created = await SELF.fetch("http://localhost/api/sessions", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ title: "Origin room", ...await testRepositorySelection(owner.headers) }),
    });
    const { session } = await created.json() as { session: { id: string } };
    const originPath = `/session/${session.id}`;

    const memberPage = await SELF.fetch(`http://localhost/home/settings?from=${encodeURIComponent(originPath)}`, { headers: owner.headers });
    expect(memberPage.status).toBe(200);
    const memberHtml = await memberPage.text();
    expect(memberHtml).toContain(`href="${originPath}"`);
    expect(memberHtml).toContain("Origin room");

    const outsider = await onboardedUser("settings-origin-outsider", "Origin", "Outsider");
    const concealedPage = await SELF.fetch(`http://localhost/home/settings?from=${encodeURIComponent(originPath)}`, { headers: outsider.headers });
    expect(concealedPage.status).toBe(200);
    const concealedHtml = await concealedPage.text();
    expect(concealedHtml).toContain('href="/home"');
    expect(concealedHtml).not.toContain("Origin room");
  });

  it("an authenticated but not-yet-onboarded user is redirected to /onboarding", async () => {
    const headers = {
      accept: "text/html",
      host: "localhost",
      "x-openfloor-dev-user-id": "settings-not-onboarded",
      "x-openfloor-dev-user-email": "settings-not-onboarded@example.com",
      "x-openfloor-dev-user-name": "Not Onboarded",
    };
    const response = await SELF.fetch("http://localhost/home/settings", { headers, redirect: "manual" });
    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.status).toBeLessThan(400);
    expect(response.headers.get("location")).toContain("/onboarding?return_to=%2Fhome%2Fsettings");
  });
});

describe("plan-selection onboarding", () => {
  it("requires direct signups to choose Free, Pro, or Max and displays Enterprise", async () => {
    const headers = {
      accept: "text/html", host: "localhost",
      "x-openfloor-dev-user-id": "plan-choice-new",
      "x-openfloor-dev-user-email": "plan-choice-new@example.com",
      "x-openfloor-dev-user-name": "Plan Choice",
    };
    const response = await SELF.fetch("http://localhost/onboarding?return_to=%2Fhome", { headers });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("product-shell shop-shell onboarding-shell");
    expect(html).toContain("Account setup progress");
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("Create your profile");
    expect(html).toContain("Choose your plan");
    expect(html).toMatch(/\$<!-- -->30<!-- -->\/seat\/month|\$30\/seat\/month/);
    expect(html).toMatch(/\$<!-- -->50<!-- -->\/seat\/month|\$50\/seat\/month/);
    expect(html).toContain("Contact sales");
    expect(html).toContain('href="mailto:hello@opnflr.com"');
  });

  it("rejects a direct signup until a plan is explicitly selected", async () => {
    const headers = {
      accept: "application/json", host: "localhost",
      "x-openfloor-dev-user-id": "plan-choice-missing",
      "x-openfloor-dev-user-email": "plan-choice-missing@example.com",
      "x-openfloor-dev-user-name": "Plan Missing",
    };
    const form = new FormData();
    form.set("firstName", "Plan");
    form.set("lastName", "Missing");
    form.set("returnTo", "/home");
    const response = await SELF.fetch("http://localhost/api/account/onboarding", { method: "POST", headers, body: form });
    expect(response.status).toBe(400);
  });

  it("does not treat a fabricated invite return path as an automatic Free selection", async () => {
    const headers = {
      accept: "application/json", host: "localhost",
      "x-openfloor-dev-user-id": "plan-choice-fake-invite",
      "x-openfloor-dev-user-email": "plan-choice-fake-invite@example.com",
      "x-openfloor-dev-user-name": "Fake Invite",
    };
    const form = new FormData();
    form.set("firstName", "Fake");
    form.set("lastName", "Invite");
    form.set("returnTo", "/join/fabricated.signature");
    const response = await SELF.fetch("http://localhost/api/account/onboarding", { method: "POST", headers, body: form });
    expect(response.status).toBe(400);
  });

  it("gives a valid-invite signup Free automatically before explicit join", async () => {
    const owner = await onboardedUser("invite-plan-owner", "Invite", "Owner");
    const created = await SELF.fetch("http://localhost/api/sessions", {
      method: "POST", headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ title: "Invite plan room", ...await testRepositorySelection(owner.headers) }),
    });
    const payload = await created.json() as { inviteUrl: string };
    const invitePath = new URL(payload.inviteUrl).pathname;
    const headers = {
      accept: "text/html", host: "localhost",
      "x-openfloor-dev-user-id": "invite-plan-new",
      "x-openfloor-dev-user-email": "invite-plan-new@example.com",
      "x-openfloor-dev-user-name": "Invite New",
    };
    const onboardingUrl = `http://localhost/onboarding?return_to=${encodeURIComponent(invitePath)}`;
    const page = await SELF.fetch(onboardingUrl, { headers });
    const html = await page.text();
    expect(html).toContain("Your invite includes Free");
    expect(html).toContain("This invite includes a Free openfloor account");

    await completeTestOnboarding(headers, "Invite", "New", invitePath);
    expect((await SELF.fetch(`http://localhost${invitePath}`, { headers })).status).toBe(200);
  });
});

describe("sign-out", () => {
  it("clears the app-domain cookie and returns a page that ends the team-domain session client-side then lands on '/'", async () => {
    const response = await SELF.fetch("http://localhost/signout", { redirect: "manual" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/html\b/i);
    expect(response.headers.get("set-cookie")).toMatch(/^CF_Authorization=;.*Max-Age=0/);

    const html = await response.text();
    expect(html).toContain('"https://openfloor-render-test.cloudflareaccess.com/cdn-cgi/access/logout"');
    expect(html).toContain('mode: "no-cors"');
    expect(html).toContain('window.location.replace("/")');
  });
});

// The pool's ACCESS_CUSTOM_LOGIN_ENABLED and OPENFLOOR_TEST_ACCESS_LOGIN_*
// bindings (vitest.render.config.ts) are fixed for this whole suite, so this
// only proves the built app wires the happy path together end to end
// through real Next rendering — flag-off behavior, extraction failure, and
// SSRF-shaped inputs are covered with full per-case control in
// tests/worker/access-paths.test.ts, tests/worker/access-login.test.ts, and
// tests/worker/signin-code-route.test.ts instead.
describe("custom sign-in", () => {
  it("renders the extracted email form and a Google link at the real protected path", async () => {
    const response = await SELF.fetch(`http://localhost/signin?return_to=${encodeURIComponent("/session/private-room")}`, {
      headers: { accept: "text/html" },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('name="action" value="https://openfloor-render-test.cloudflareaccess.com/cdn-cgi/access/verify-code/app.opnflr.com?kid=render-fixture&amp;meta=render-fixture"');
    expect(html).toContain('href="/session/private-room">Continue with Google');
    expect(html).toContain('action="/signin/code?return_to=%2Fsession%2Fprivate-room"');
  });

  it("code step: submitting the email renders the code form pointed at Cloudflare's real callback", async () => {
    const form = new FormData();
    form.set("email", "render-signin@example.com");
    form.set("action", "https://openfloor-render-test.cloudflareaccess.com/cdn-cgi/access/verify-code/app.opnflr.com?kid=render-fixture&meta=render-fixture");
    const response = await SELF.fetch("http://localhost/signin/code?return_to=%2Fhome", { method: "POST", body: form });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('action="https://openfloor-render-test.cloudflareaccess.com/cdn-cgi/access/callback"');
    expect(html).toContain('value="render-fixture-nonce"');
    expect(html).toContain("We sent a code to render-signin@example.com.");
    // Regression: this page hand-builds a standalone HTML document — an
    // earlier version resolved the app's compiled stylesheet via a
    // same-origin self-fetch, which proved unreliable in production and
    // shipped completely unstyled. Styling is now inlined directly.
    expect(html).toContain("<style>");
    expect(html).toContain(".entry-shell{");
  });
});

describe("a browser navigation stranded on a bare /api path", () => {
  it("redirects to /home instead of rendering Not Found", async () => {
    const response = await SELF.fetch("http://localhost/api/nope", {
      headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://localhost/home");
  });

  it("leaves a real API 404 alone", async () => {
    const response = await SELF.fetch("http://localhost/api/nope", {
      headers: { accept: "application/json" },
    });
    expect(response.status).toBe(404);
  });
});
