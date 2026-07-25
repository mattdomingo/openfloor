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
  assert.match(html, /PLANNED SCOPE CONFLICT/);
  assert.match(html, /Atlas/);
  assert.match(html, /Nova/);
  assert.match(html, /Sentry/);
  assert.match(html, /Proof/);
  assert.match(html, /Participants: Matt, Ryan, and Ali/);
  assert.match(html, /Codebase/);
  assert.match(html, /All agents/);
  assert.match(html, /LIVE FLOOR/);
  assert.match(html, /Your session input/);
  assert.match(html, /Main session input/);
  assert.match(html, /Editable session goal/);
  assert.match(html, /ENGINEER OWNERSHIP/);
  assert.match(html, /Dispatch a task, reply to a teammate, or steer the session/);
  assert.match(html, /Candidate branch/);
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
