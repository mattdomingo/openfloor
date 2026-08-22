import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Accepted keys come from OPENFLOOR_TEST_PROVIDER_KEYS in
// vitest.render.config.ts — the deterministic connect-time validation adapter.
const ACCEPTED_ANTHROPIC_KEY = "sk-ant-render-accepted";
const ACCEPTED_OPENAI_KEY = "sk-openai-render-accepted";

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
  form.set("plan", "free");
  form.set("returnTo", "/app/home");
  const onboarded = await SELF.fetch("http://localhost/app/api/account/onboarding", { method: "POST", headers, body: form });
  expect(onboarded.status).toBe(200);
  const row = await env.DB.prepare("SELECT id FROM users WHERE chatgpt_user_id = ?").bind(providerUserId).first<{ id: string }>();
  if (!row) throw new Error("Onboarded user was not persisted");
  return { userId: row.id, headers };
}

function jsonHeaders(headers: Record<string, string>) {
  return { ...headers, "content-type": "application/json" };
}

describe("provider credential routes", () => {
  it("requires authentication", async () => {
    const list = await SELF.fetch("http://localhost/app/api/account/credentials");
    expect(list.status).toBe(401);
    const put = await SELF.fetch("http://localhost/app/api/account/credentials/anthropic", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: ACCEPTED_ANTHROPIC_KEY }),
    });
    expect(put.status).toBe(401);
    const remove = await SELF.fetch("http://localhost/app/api/account/credentials/anthropic", { method: "DELETE" });
    expect(remove.status).toBe(401);
  });

  it("connects, lists, and disconnects a credential without ever returning the key", async () => {
    const { userId, headers } = await onboardedUser("credentials-owner", "Cred", "Owner");

    const empty = await SELF.fetch("http://localhost/app/api/account/credentials", { headers });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ credentials: [] });

    const connected = await SELF.fetch("http://localhost/app/api/account/credentials/anthropic", {
      method: "PUT",
      headers: jsonHeaders(headers),
      body: JSON.stringify({ apiKey: ACCEPTED_ANTHROPIC_KEY }),
    });
    expect(connected.status).toBe(200);
    const connectedText = await connected.text();
    expect(connectedText).not.toContain(ACCEPTED_ANTHROPIC_KEY);
    const { credential } = JSON.parse(connectedText) as {
      credential: { provider: string; kind: string; fingerprint: string; validatedAt: number | null };
    };
    expect(credential.provider).toBe("anthropic");
    expect(credential.kind).toBe("api_key");
    expect(credential.fingerprint).toBe(ACCEPTED_ANTHROPIC_KEY.slice(-4));
    expect(credential.validatedAt).not.toBeNull();

    // At rest the value is ciphertext, not the key.
    const stored = await env.DB.prepare("SELECT ciphertext FROM user_provider_credentials WHERE user_id = ? AND provider = 'anthropic'")
      .bind(userId)
      .first<{ ciphertext: string }>();
    expect(stored?.ciphertext).toBeTruthy();
    expect(stored?.ciphertext).not.toContain(ACCEPTED_ANTHROPIC_KEY);

    const listed = await SELF.fetch("http://localhost/app/api/account/credentials", { headers });
    const listedText = await listed.text();
    expect(listedText).not.toContain(ACCEPTED_ANTHROPIC_KEY);
    expect((JSON.parse(listedText) as { credentials: unknown[] }).credentials).toHaveLength(1);

    const removed = await SELF.fetch("http://localhost/app/api/account/credentials/anthropic", { method: "DELETE", headers });
    expect(removed.status).toBe(204);
    const afterDelete = await SELF.fetch("http://localhost/app/api/account/credentials", { headers });
    expect(await afterDelete.json()).toEqual({ credentials: [] });
  });

  it("rejects invalid keys, invalid input, and unknown providers", async () => {
    const { headers } = await onboardedUser("credentials-reject", "Cred", "Reject");

    const rejectedKey = await SELF.fetch("http://localhost/app/api/account/credentials/openai", {
      method: "PUT",
      headers: jsonHeaders(headers),
      body: JSON.stringify({ apiKey: "sk-openai-render-wrong" }),
    });
    expect(rejectedKey.status).toBe(400);
    expect(((await rejectedKey.json()) as { error: string }).error).toContain("OpenAI");

    const badInput = await SELF.fetch("http://localhost/app/api/account/credentials/openai", {
      method: "PUT",
      headers: jsonHeaders(headers),
      body: JSON.stringify({ apiKey: "two tokens" }),
    });
    expect(badInput.status).toBe(400);

    const unknownProvider = await SELF.fetch("http://localhost/app/api/account/credentials/gemini", {
      method: "PUT",
      headers: jsonHeaders(headers),
      body: JSON.stringify({ apiKey: ACCEPTED_OPENAI_KEY }),
    });
    expect(unknownProvider.status).toBe(404);

    // Nothing was stored by any of the rejected attempts.
    const list = await SELF.fetch("http://localhost/app/api/account/credentials", { headers });
    expect(await list.json()).toEqual({ credentials: [] });
  });

  it("shows the Connections section on /settings", async () => {
    const { headers } = await onboardedUser("credentials-settings", "Cred", "Settings");
    const response = await SELF.fetch("http://localhost/app/settings", { headers });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Connections");
  });
});
