import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const BASE_PATH = "/app";

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
    expect(html).toContain("Build together without losing the thread.");
    expect(html).toContain("Sign in with your email or a Google account.");
    expect(html).not.toMatch(/Register|Guest|Session code|type="password"|mock/i);
    expect(html).not.toContain("signin-with-chatgpt");
  });

  it("explains the sign-in bounce and points the CTA back at the requested page", async () => {
    const response = await fetchPath(`${BASE_PATH}?auth=required&return_to=${encodeURIComponent("/app/session/private-room")}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Sign in to open that page. You will be sent back to it.");
    expect(html).toContain('href="/app/session/private-room"');
    // Without the params the landing stays quiet.
    const plain = await (await render()).text();
    expect(plain).not.toContain("Sign in to open that page");
  });

  it("rejects browser-normalized external return URLs", async () => {
    const response = await fetchPath(`${BASE_PATH}?return_to=${encodeURIComponent("/\\evil.example/phish")}`);
    const html = await response.text();
    expect(html).toContain(`href="${BASE_PATH}/home"`);
    expect(html).not.toMatch(/<a[^>]+href="\/\\evil\.example\/phish"/i);
  });

  it("redirects every protected page to the public landing page", async () => {
    for (const path of ["/home", "/session/private-room", "/session/private-room/floor", "/join/not-a-token"]) {
      const response = await render(path);
      expect(response.status).toBeGreaterThanOrEqual(300);
      expect(response.status).toBeLessThan(400);
      expect(response.headers.get("location")).toContain("/app?auth=required&return_to=%2Fapp%2F");
    }
  });

  it("emits product social metadata from the request origin", async () => {
    const html = await (await render()).text();
    expect(html).toContain('property="og:title" content="openfloor"');
    expect(html).toContain('property="og:image" content="http://localhost:3000/app/og-v3.png"');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
  });

  it("renders an authenticated floor with no seeded product data", async () => {
    const onboardingForm = new FormData();
    onboardingForm.set("firstName", "Render");
    onboardingForm.set("lastName", "Owner");
    const onboarded = await SELF.fetch("http://localhost/app/api/account/onboarding", {
      method: "POST",
      headers: authenticatedHeaders,
      body: onboardingForm,
    });
    expect(onboarded.status).toBe(204);

    const created = await SELF.fetch("http://localhost/app/api/sessions", {
      method: "POST",
      headers: { ...authenticatedHeaders, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ title: "Empty floor" }),
    });
    expect(created.status).toBe(201);
    const { session } = await created.json() as { session: { id: string } };
    const response = await SELF.fetch(`http://localhost/app/session/${session.id}/floor`, { headers: authenticatedHeaders });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("No agents yet");
    expect(html).toContain("No prompts waiting");
    expect(html).toContain("Teammate drafts");
    expect(html).toContain("Everyone");
    expect(html).toContain("Typing");
    expect(html).toContain("Hidden");
    expect(html).not.toMatch(/Atlas|Nova|Sentry|Proof|OpenMind|server\/session\/reducer/i);
  });

  it("serves nothing outside its base path", async () => {
    for (const path of ["/", "/home", "/why", "/session/private-room"]) {
      expect((await fetchPath(path)).status).toBe(404);
    }
  });
});

async function onboardedUser(providerUserId: string, firstName: string, lastName: string) {
  const headers = {
    accept: "text/html",
    host: "localhost",
    "x-openfloor-dev-user-id": providerUserId,
    "x-openfloor-dev-user-email": `${providerUserId}@example.com`,
    "x-openfloor-dev-user-name": `${firstName} ${lastName}`,
  };
  const form = new FormData();
  form.set("firstName", firstName);
  form.set("lastName", lastName);
  const onboarded = await SELF.fetch("http://localhost/app/api/account/onboarding", { method: "POST", headers, body: form });
  expect(onboarded.status).toBe(204);
  const row = await env.DB.prepare("SELECT id FROM users WHERE chatgpt_user_id = ?").bind(providerUserId).first<{ id: string }>();
  if (!row) throw new Error("Onboarded user was not persisted");
  return { userId: row.id, headers };
}

describe("plan-limits UI", () => {
  it("a new user's /app/home shows the free-tier copy", async () => {
    const { headers } = await onboardedUser("plan-free-user", "Free", "User");
    const response = await SELF.fetch("http://localhost/app/home", { headers });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Free plan");
    expect(html).toContain("of 2h session time used this month (UTC)");
  });

  it("seeding usage_months to the cap renders the exhausted notice and the upgrade link", async () => {
    const { userId, headers } = await onboardedUser("plan-exhausted-user", "Exhausted", "User");
    const month = new Date().toISOString().slice(0, 7); // UTC "YYYY-MM", matching lib/plans.ts:currentMonth
    await env.DB.prepare("INSERT INTO usage_months (owner_user_id, month, seconds) VALUES (?, ?, ?)")
      .bind(userId, month, 2 * 3600)
      .run();
    const response = await SELF.fetch("http://localhost/app/home", { headers });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("2h of monthly session time is used up");
    expect(html).toContain("https://buy.stripe.com/fZudR93OAaWMehu35t4F200");
  });

  it("POST /app/api/sessions returns 403 with code quota_exhausted once the free cap is spent", async () => {
    const { userId, headers } = await onboardedUser("plan-exhausted-api-user", "ExhaustedApi", "User");
    const month = new Date().toISOString().slice(0, 7);
    await env.DB.prepare("INSERT INTO usage_months (owner_user_id, month, seconds) VALUES (?, ?, ?)")
      .bind(userId, month, 2 * 3600)
      .run();
    const response = await SELF.fetch("http://localhost/app/api/sessions", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ title: "Should be refused" }),
    });
    expect(response.status).toBe(403);
    const body = await response.json() as { error?: string; code?: string };
    expect(body.code).toBe("quota_exhausted");
  });

  it("an enterprise, active user renders the unlimited copy without crashing", async () => {
    const { userId, headers } = await onboardedUser("plan-enterprise-user", "Enterprise", "User");
    await env.DB.prepare("UPDATE users SET plan = 'enterprise', plan_status = 'active' WHERE id = ?").bind(userId).run();
    const response = await SELF.fetch("http://localhost/app/home", { headers });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Enterprise plan");
    expect(html).toContain("session time used this month (UTC)");
    expect(html).not.toContain("of undefinedh");
    expect(html).not.toContain("NaN");
  });
});
