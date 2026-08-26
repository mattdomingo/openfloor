import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { completeTestOnboarding } from "./github-fixture";

// Accepted keys come from OPENFLOOR_TEST_PROVIDER_KEYS in
// vitest.render.config.ts — the deterministic connect-time validation adapter.
const ACCEPTED_ANTHROPIC_KEY = "sk-ant-render-accepted";
const ACCEPTED_OPENAI_KEY = "sk-openai-render-accepted";
const ACCEPTED_KIMI_KEY = "sk-kimi-render-accepted";
const ACCEPTED_GEMINI_KEY = "AIza-gemini-render-accepted";
const ACCEPTED_GLM_KEY = "zai-glm-render-accepted";

async function onboardedUser(providerUserId: string, firstName: string, lastName: string) {
  const headers = {
    accept: "text/html",
    host: "localhost",
    "x-openfloor-dev-user-id": providerUserId,
    "x-openfloor-dev-user-email": `${providerUserId}@example.com`,
    "x-openfloor-dev-user-name": `${firstName} ${lastName}`,
  };
  await completeTestOnboarding(headers, firstName, lastName);
  const row = await env.DB.prepare("SELECT id FROM users WHERE chatgpt_user_id = ?").bind(providerUserId).first<{ id: string }>();
  if (!row) throw new Error("Onboarded user was not persisted");
  return { userId: row.id, headers };
}

function jsonHeaders(headers: Record<string, string>) {
  return { ...headers, "content-type": "application/json" };
}

describe("provider credential routes", () => {
  it("requires authentication", async () => {
    const list = await SELF.fetch("http://localhost/api/account/credentials");
    expect(list.status).toBe(401);
    const put = await SELF.fetch("http://localhost/api/account/credentials/anthropic", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: ACCEPTED_ANTHROPIC_KEY }),
    });
    expect(put.status).toBe(401);
    const remove = await SELF.fetch("http://localhost/api/account/credentials/anthropic", { method: "DELETE" });
    expect(remove.status).toBe(401);
  });

  it("connects, lists, and disconnects a credential without ever returning the key", async () => {
    const { userId, headers } = await onboardedUser("credentials-owner", "Cred", "Owner");

    const empty = await SELF.fetch("http://localhost/api/account/credentials", { headers });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ credentials: [] });

    const connected = await SELF.fetch("http://localhost/api/account/credentials/anthropic", {
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

    const listed = await SELF.fetch("http://localhost/api/account/credentials", { headers });
    const listedText = await listed.text();
    expect(listedText).not.toContain(ACCEPTED_ANTHROPIC_KEY);
    expect((JSON.parse(listedText) as { credentials: unknown[] }).credentials).toHaveLength(1);

    const removed = await SELF.fetch("http://localhost/api/account/credentials/anthropic", { method: "DELETE", headers });
    expect(removed.status).toBe(204);
    const afterDelete = await SELF.fetch("http://localhost/api/account/credentials", { headers });
    expect(await afterDelete.json()).toEqual({ credentials: [] });
  });

  it("connects and disconnects the kimi, gemini, and glm providers through the same flow", async () => {
    const { headers } = await onboardedUser("credentials-new-providers", "Cred", "Newer");
    for (const [provider, apiKey] of [["kimi", ACCEPTED_KIMI_KEY], ["gemini", ACCEPTED_GEMINI_KEY], ["glm", ACCEPTED_GLM_KEY]] as const) {
      const connected = await SELF.fetch(`http://localhost/api/account/credentials/${provider}`, {
        method: "PUT",
        headers: jsonHeaders(headers),
        body: JSON.stringify({ apiKey }),
      });
      expect(connected.status).toBe(200);
      const { credential } = (await connected.json()) as { credential: { provider: string; fingerprint: string; validatedAt: number | null } };
      expect(credential.provider).toBe(provider);
      expect(credential.fingerprint).toBe(apiKey.slice(-4));
      expect(credential.validatedAt).not.toBeNull();
    }
    const rejected = await SELF.fetch("http://localhost/api/account/credentials/kimi", {
      method: "PUT",
      headers: jsonHeaders(headers),
      body: JSON.stringify({ apiKey: "sk-kimi-render-wrong" }),
    });
    expect(rejected.status).toBe(400);
    expect(((await rejected.json()) as { error: string }).error).toContain("Moonshot");
    const removed = await SELF.fetch("http://localhost/api/account/credentials/gemini", { method: "DELETE", headers });
    expect(removed.status).toBe(204);
    const list = await SELF.fetch("http://localhost/api/account/credentials", { headers });
    expect(((await list.json()) as { credentials: Array<{ provider: string }> }).credentials.map((entry) => entry.provider)).toEqual(["glm", "kimi"]);
  });

  it("connects a subscription credential alongside the API key, disconnecting per kind", async () => {
    const { headers } = await onboardedUser("credentials-subscription", "Cred", "Sub");
    const key = await SELF.fetch("http://localhost/api/account/credentials/anthropic", {
      method: "PUT",
      headers: jsonHeaders(headers),
      body: JSON.stringify({ apiKey: ACCEPTED_ANTHROPIC_KEY }),
    });
    expect(key.status).toBe(200);
    // A setup token validates on connect (GET /v1/models, plain Bearer —
    // Spike C rerun), so a good one stores a real validated_at and a bad one
    // is a 400, exactly like an API key.
    const rejectedSub = await SELF.fetch("http://localhost/api/account/credentials/anthropic", {
      method: "PUT",
      headers: jsonHeaders(headers),
      body: JSON.stringify({ setupToken: "sk-ant-oat01-render-wrong" }),
    });
    expect(rejectedSub.status).toBe(400);
    expect(((await rejectedSub.json()) as { error: string }).error).toContain("setup token");
    const setupToken = "sk-ant-oat01-render-accepted";
    const sub = await SELF.fetch("http://localhost/api/account/credentials/anthropic", {
      method: "PUT",
      headers: jsonHeaders(headers),
      body: JSON.stringify({ setupToken }),
    });
    expect(sub.status).toBe(200);
    const subText = await sub.text();
    expect(subText).not.toContain(setupToken);
    const { credential } = JSON.parse(subText) as { credential: { kind: string; fingerprint: string; validatedAt: number | null } };
    expect(credential.kind).toBe("oauth");
    expect(credential.fingerprint).toBe(setupToken.slice(-4));
    expect(credential.validatedAt).not.toBeNull();
    // openai's ChatGPT-bundle kind is withheld until §5 ships: the authJson
    // shape parses, but the provider refuses the kind — no stored credential
    // every run of which would 503.
    const bundle = await SELF.fetch("http://localhost/api/account/credentials/openai", {
      method: "PUT",
      headers: jsonHeaders(headers),
      body: JSON.stringify({ authJson: JSON.stringify({ tokens: { account_id: "acct-render-1234", access_token: "at" } }) }),
    });
    expect(bundle.status).toBe(400);
    // Rows list deterministically: by provider, then kind.
    const listed = await SELF.fetch("http://localhost/api/account/credentials", { headers });
    expect(((await listed.json()) as { credentials: Array<{ provider: string; kind: string }> }).credentials
      .map((entry) => `${entry.provider}:${entry.kind}`)).toEqual(["anthropic:api_key", "anthropic:oauth"]);
    // Providers without a subscription kind refuse it. (This used kimi until
    // its Kimi Code plan kind became real on 2026-08-26; gemini stays
    // api_key-only.)
    const refused = await SELF.fetch("http://localhost/api/account/credentials/gemini", {
      method: "PUT",
      headers: jsonHeaders(headers),
      body: JSON.stringify({ setupToken }),
    });
    expect(refused.status).toBe(400);
    // Disconnect is kind-scoped: the subscription goes, the API key stays.
    // An oauth kind on a provider that withholds it is a 404 both ways.
    expect((await SELF.fetch("http://localhost/api/account/credentials/anthropic?kind=bogus", { method: "DELETE", headers })).status).toBe(404);
    expect((await SELF.fetch("http://localhost/api/account/credentials/openai?kind=oauth", { method: "DELETE", headers })).status).toBe(404);
    expect((await SELF.fetch("http://localhost/api/account/credentials/anthropic?kind=oauth", { method: "DELETE", headers })).status).toBe(204);
    const after = await SELF.fetch("http://localhost/api/account/credentials", { headers });
    expect(((await after.json()) as { credentials: Array<{ provider: string; kind: string }> }).credentials
      .map((entry) => `${entry.provider}:${entry.kind}`)).toEqual(["anthropic:api_key"]);
  });

  it("connects a Kimi Code plan key alongside the Moonshot API key, unverified until its first run", async () => {
    const { headers } = await onboardedUser("credentials-kimi-plan", "Cred", "Plan");
    const key = await SELF.fetch("http://localhost/api/account/credentials/kimi", {
      method: "PUT",
      headers: jsonHeaders(headers),
      body: JSON.stringify({ apiKey: ACCEPTED_KIMI_KEY }),
    });
    expect(key.status).toBe(200);
    // A plan key has no connect-time probe (the plan surface is
    // vendor-documented but unverified with a live plan key — 2026-08-26
    // decision-log entry), so the row stores validated_at null: "Connected —
    // not yet verified", and the first run is the real validation. Never a
    // faked timestamp.
    const planToken = "sk-kimi-plan-render-5678";
    const plan = await SELF.fetch("http://localhost/api/account/credentials/kimi", {
      method: "PUT",
      headers: jsonHeaders(headers),
      body: JSON.stringify({ setupToken: planToken }),
    });
    expect(plan.status).toBe(200);
    const planText = await plan.text();
    expect(planText).not.toContain(planToken);
    const { credential } = JSON.parse(planText) as { credential: { kind: string; fingerprint: string; validatedAt: number | null } };
    expect(credential.kind).toBe("oauth");
    expect(credential.fingerprint).toBe(planToken.slice(-4));
    expect(credential.validatedAt).toBeNull();
    // Rows list deterministically: by provider, then kind.
    const listed = await SELF.fetch("http://localhost/api/account/credentials", { headers });
    expect(((await listed.json()) as { credentials: Array<{ provider: string; kind: string }> }).credentials
      .map((entry) => `${entry.provider}:${entry.kind}`)).toEqual(["kimi:api_key", "kimi:oauth"]);
    // Disconnect is kind-scoped: the plan row goes, the API key stays.
    expect((await SELF.fetch("http://localhost/api/account/credentials/kimi?kind=oauth", { method: "DELETE", headers })).status).toBe(204);
    const after = await SELF.fetch("http://localhost/api/account/credentials", { headers });
    expect(((await after.json()) as { credentials: Array<{ provider: string; kind: string }> }).credentials
      .map((entry) => `${entry.provider}:${entry.kind}`)).toEqual(["kimi:api_key"]);
  });

  it("rejects invalid keys, invalid input, and unknown providers", async () => {
    const { headers } = await onboardedUser("credentials-reject", "Cred", "Reject");

    const rejectedKey = await SELF.fetch("http://localhost/api/account/credentials/openai", {
      method: "PUT",
      headers: jsonHeaders(headers),
      body: JSON.stringify({ apiKey: "sk-openai-render-wrong" }),
    });
    expect(rejectedKey.status).toBe(400);
    expect(((await rejectedKey.json()) as { error: string }).error).toContain("OpenAI");

    const badInput = await SELF.fetch("http://localhost/api/account/credentials/openai", {
      method: "PUT",
      headers: jsonHeaders(headers),
      body: JSON.stringify({ apiKey: "two tokens" }),
    });
    expect(badInput.status).toBe(400);

    const unknownProvider = await SELF.fetch("http://localhost/api/account/credentials/mistral", {
      method: "PUT",
      headers: jsonHeaders(headers),
      body: JSON.stringify({ apiKey: ACCEPTED_OPENAI_KEY }),
    });
    expect(unknownProvider.status).toBe(404);

    // Nothing was stored by any of the rejected attempts.
    const list = await SELF.fetch("http://localhost/api/account/credentials", { headers });
    expect(await list.json()).toEqual({ credentials: [] });
  });

  it("shows the Connections section on /home/settings", async () => {
    const { headers } = await onboardedUser("credentials-settings", "Cred", "Settings");
    const response = await SELF.fetch("http://localhost/home/settings", { headers });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Connections");
  });
});
