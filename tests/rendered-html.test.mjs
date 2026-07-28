import assert from "node:assert/strict";
import test from "node:test";

// The app is mounted under /app so it can share opnflr.com with the marketing
// site. Paths here are app-relative; fetchPath() is the raw URL the Worker sees.
const BASE_PATH = "/app";

async function fetchPath(path) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

async function render(path = "/") {
  return fetchPath(path === "/" ? BASE_PATH : BASE_PATH + path);
}

test("server-renders the OpenFloor landing page", async () => {
  const response = await render("/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>OpenFloor — Multiplayer agent development<\/title>/i);
  assert.match(html, /A shared control plane for teams coordinating coding agents/);
  assert.match(html, />Log in</);
  assert.match(html, />Register</);
  assert.match(html, />Join a session</);
  assert.match(html, /Email/);
  assert.match(html, /Password/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
});

test("gated routes exist and still resolve to the app shell", async () => {
  // /home and /session/[id] are gated behind a client-only mock login check
  // (localStorage isn't available during SSR), so their real content only
  // renders after hydration. This just confirms the routes themselves work.
  for (const path of ["/home", "/session/realtime-presence"]) {
    const response = await render(path);
    assert.equal(response.status, 200, `expected 200 for ${path}`);
    const html = await response.text();
    assert.match(html, /<title>OpenFloor — Multiplayer agent development<\/title>/i);
  }
});

test("emits product social metadata from the request origin", async () => {
  const response = await render("/");
  const html = await response.text();
  assert.match(html, /property="og:title" content="OpenFloor"/);
  assert.match(html, /property="og:image" content="http:\/\/localhost:3000\/app\/og-v3.png"/);
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
});

// The marketing site owns every other path on opnflr.com. If the app ever
// answers outside its prefix the two deploys are fighting over the same URL,
// and whichever Cloudflare picks first wins — so pin the mount point.
test("serves nothing outside its basePath", async () => {
  for (const path of ["/", "/home", "/why", "/session/realtime-presence"]) {
    const response = await fetchPath(path);
    assert.equal(response.status, 404, `expected 404 for un-prefixed ${path}`);
  }
});
