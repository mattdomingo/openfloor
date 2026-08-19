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
  it("renders the public OpenFloor landing page without demo auth", async () => {
    const response = await render();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/html\b/i);

    const html = await response.text();
    expect(html).toMatch(/<title>OpenFloor — Multiplayer agent development<\/title>/i);
    expect(html).toContain("Build together without losing the thread.");
    expect(html).toContain("Continue with email or Google");
    expect(html).not.toMatch(/Register|Guest|Session code|type="password"|mock/i);
    expect(html).not.toContain("signin-with-chatgpt");
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
    expect(html).toContain('property="og:title" content="OpenFloor"');
    expect(html).toContain('property="og:image" content="http://localhost:3000/app/og-v3.png"');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
  });

  it("renders an authenticated floor with no seeded product data", async () => {
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
