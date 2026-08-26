import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { completeTestOnboarding, testRepositorySelection } from "./github-fixture";

function identity(id: string) {
  return {
    accept: "application/json",
    host: "localhost",
    "x-openfloor-dev-user-id": id,
    "x-openfloor-dev-user-email": `${id}@example.com`,
    "x-openfloor-dev-user-name": "Delete Owner",
  };
}

async function createOwnedSession(id: string) {
  const headers = identity(id);
  await completeTestOnboarding(headers, "Delete", "Owner");
  const response = await SELF.fetch("http://localhost/api/sessions", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ title: `Delete ${id}`, ...await testRepositorySelection(headers) }),
  });
  expect(response.status).toBe(201);
  const body = await response.json() as { session: { id: string } };
  return { headers, sessionId: body.session.id };
}

describe("deletion routes", () => {
  it("deletes a session when optional candidate-branch cleanup fails", async () => {
    const { headers, sessionId } = await createOwnedSession("delete-session-route");

    const choice = await SELF.fetch(`http://localhost/api/sessions/${sessionId}`, { method: "DELETE", headers });
    expect(choice.status).toBe(409);
    await expect(choice.json()).resolves.toMatchObject({ code: "candidate_live" });

    const bindings = env as unknown as Record<string, unknown>;
    const githubFixture = bindings.OPENFLOOR_TEST_GITHUB_DATA;
    bindings.OPENFLOOR_TEST_GITHUB_DATA = "{";
    const deleted = await SELF.fetch(`http://localhost/api/sessions/${sessionId}`, {
      method: "DELETE",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ candidate: "delete-branch" }),
    }).finally(() => { bindings.OPENFLOOR_TEST_GITHUB_DATA = githubFixture; });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({ deleted: true, warning: expect.any(String) });
    expect(await env.DB.prepare("SELECT id FROM sessions WHERE id = ?").bind(sessionId).first()).toBeNull();
  });

  it("deletes an account when optional candidate-branch cleanup fails", async () => {
    const { headers, sessionId } = await createOwnedSession("delete-account-route");

    const bindings = env as unknown as Record<string, unknown>;
    const githubFixture = bindings.OPENFLOOR_TEST_GITHUB_DATA;
    bindings.OPENFLOOR_TEST_GITHUB_DATA = "{";
    const deleted = await SELF.fetch("http://localhost/api/account", {
      method: "DELETE",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ confirm: "DELETE", deleteBranches: true }),
    }).finally(() => { bindings.OPENFLOOR_TEST_GITHUB_DATA = githubFixture; });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({ deleted: true, orphanedBranches: [expect.any(String)] });
    expect(await env.DB.prepare("SELECT id FROM sessions WHERE id = ?").bind(sessionId).first()).toBeNull();
  });
});
