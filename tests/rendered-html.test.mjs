import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the OpenFloor session control plane", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>OpenFloor — Multiplayer agent development<\/title>/i);
  assert.match(html, /Ship realtime presence and agent activity/);
  assert.match(html, /Needs you/);
  assert.match(html, /both claim/);
  assert.match(html, /Atlas/);
  assert.match(html, /Nova/);
  assert.match(html, /Sentry/);
  assert.match(html, /Proof/);
  assert.match(html, /Participants: Matt, Ryan, and Ali/);
  assert.match(html, /Codebase/);
  assert.match(html, /All agents/);
  assert.match(html, /New agent/);
  assert.match(html, /Open floor/);
  assert.match(html, /Queue for/);
  assert.match(html, /Drafting on the floor/);
  assert.match(html, /Edit session objective/);
  assert.match(html, /Ownership/);
  assert.match(html, /Describe work to queue for/);
  assert.match(html, />Queue</);
  assert.match(html, /aria-label="Queue scope"/);
  assert.match(html, /Queue position 1/);
  assert.doesNotMatch(html, /Your queue</);
  assert.doesNotMatch(html, /Team queue/);
  assert.match(html, /Workspace/);
  assert.match(html, /Review/);
  assert.match(html, /Add to queue/);
  assert.doesNotMatch(html, /Submitted prompts waiting/);
  assert.doesNotMatch(html, /Candidate branch/);
  assert.doesNotMatch(html, /SESSION PULSE/);
  assert.doesNotMatch(html, /Ollie/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
});

test("emits product social metadata from the request origin", async () => {
  const response = await render();
  const html = await response.text();
  assert.match(html, /property="og:title" content="OpenFloor"/);
  assert.match(html, /property="og:image" content="http:\/\/localhost:3000\/og-v3.png"/);
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
});
