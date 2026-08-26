import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_PROVIDER_LABELS,
  CREDENTIAL_PROVIDERS,
  credentialAadContext,
  credentialFingerprint,
  credentialKindLabel,
  credentialKindsForProvider,
  DEFAULT_PROVIDER_MODELS,
  parseCredentialKind,
  parseCredentialProvider,
  PROVIDER_MODELS,
  providerLabel,
  resolveRunCredentialSource,
  resolveRunModel,
  usesClaudeRunner,
} from "@/lib/provider-credentials";
import { validateProviderApiKey, validateProviderOauthSecret } from "@/lib/provider-validation";
import { MODEL_PRICING } from "@/lib/model-pricing";

describe("provider parsing and labels", () => {
  it("accepts only known providers", () => {
    expect(parseCredentialProvider("anthropic")).toBe("anthropic");
    expect(parseCredentialProvider("openai")).toBe("openai");
    expect(parseCredentialProvider("kimi")).toBe("kimi");
    expect(parseCredentialProvider("gemini")).toBe("gemini");
    expect(parseCredentialProvider("glm")).toBe("glm");
    expect(parseCredentialProvider("mistral")).toBeNull();
    expect(parseCredentialProvider("grok")).toBeNull();
    expect(parseCredentialProvider("")).toBeNull();
    expect(parseCredentialProvider(undefined)).toBeNull();
  });

  it("labels providers for people", () => {
    expect(providerLabel("anthropic")).toBe("Anthropic");
    expect(providerLabel("openai")).toBe("OpenAI");
    expect(providerLabel("kimi")).toBe("Moonshot");
    expect(providerLabel("gemini")).toBe("Google");
    expect(providerLabel("glm")).toBe("Z.ai");
  });

  it("names agents per provider and routes kimi through the Claude runner", () => {
    expect(AGENT_PROVIDER_LABELS.anthropic).toBe("Claude");
    expect(AGENT_PROVIDER_LABELS.openai).toBe("Codex");
    expect(AGENT_PROVIDER_LABELS.kimi).toBe("Kimi");
    expect(AGENT_PROVIDER_LABELS.gemini).toBe("Gemini");
    expect(AGENT_PROVIDER_LABELS.glm).toBe("GLM");
    expect(usesClaudeRunner("anthropic")).toBe(true);
    expect(usesClaudeRunner("kimi")).toBe(true);
    expect(usesClaudeRunner("glm")).toBe(true);
    expect(usesClaudeRunner("openai")).toBe(false);
    expect(usesClaudeRunner("gemini")).toBe(false);
  });

  it("fingerprints as the last four characters", () => {
    expect(credentialFingerprint("sk-ant-api03-abcd")).toBe("abcd");
  });
});

describe("per-provider run models", () => {
  it("defaults each provider and lets a nonempty agent model override", () => {
    expect(resolveRunModel("openai", null)).toBe(DEFAULT_PROVIDER_MODELS.openai);
    expect(resolveRunModel("anthropic", null)).toBe("claude-opus-5");
    expect(resolveRunModel("anthropic", "  ")).toBe("claude-opus-5");
    expect(resolveRunModel("anthropic", "claude-sonnet-5")).toBe("claude-sonnet-5");
    // Spike-verified ids: bare kimi-k3 (the "[1m]" alias 404s at the API) and
    // gemini-3.5-flash (what the pinned CLI actually sends on the wire).
    expect(resolveRunModel("kimi", null)).toBe("kimi-k3");
    expect(resolveRunModel("gemini", null)).toBe("gemini-3.5-flash");
    // glm-5.3: the coding flagship id Z.ai's models endpoint returns.
    expect(resolveRunModel("glm", null)).toBe("glm-5.3");
  });

  it("keeps the Codex default the historical AGENT_RUN_MODEL value", () => {
    expect(DEFAULT_PROVIDER_MODELS.openai).toBe("gpt-5.6-terra");
  });

  // Anti-drift: DEFAULT_PROVIDER_MODELS is a derived alias of the allowlist's
  // first entry; two independently editable lists must never exist.
  it("pins every provider's default to its allowlist's first entry", () => {
    for (const provider of CREDENTIAL_PROVIDERS) {
      expect(PROVIDER_MODELS[provider].length).toBeGreaterThan(0);
      expect(PROVIDER_MODELS[provider][0]).toBe(DEFAULT_PROVIDER_MODELS[provider]);
    }
  });

  // Anti-drift: every model a run can actually select must be priceable
  // (lib/model-pricing.ts), or the cost tile silently shows "—" for it
  // forever. A model added to PROVIDER_MODELS without a matching price entry
  // is caught here, not in production.
  it("prices every model in the allowlist", () => {
    for (const provider of CREDENTIAL_PROVIDERS) {
      for (const model of PROVIDER_MODELS[provider]) {
        expect(MODEL_PRICING[model], `${provider} model "${model}" has no MODEL_PRICING entry`).toBeDefined();
      }
    }
  });
});

describe("run credential resolution order", () => {
  it("prefers the session owner's credential", () => {
    expect(resolveRunCredentialSource({ ownerCredentialPresent: true, serverKeyPresent: true })).toEqual({ source: "owner" });
    expect(resolveRunCredentialSource({ ownerCredentialPresent: true, serverKeyPresent: false })).toEqual({ source: "owner" });
  });

  it("falls back to the server key only when the owner has none", () => {
    expect(resolveRunCredentialSource({ ownerCredentialPresent: false, serverKeyPresent: true })).toEqual({ source: "server" });
  });

  it("refuses when neither exists, saying which absence it is", () => {
    expect(resolveRunCredentialSource({ ownerCredentialPresent: false, serverKeyPresent: false }))
      .toEqual({ source: "none", reason: "no_credential" });
  });

  it("refuses an agent-named kind the owner lacks — never the server key", () => {
    // The single most important resolution assertion: an agent bound to a
    // disconnected subscription must NOT silently bill openfloor's key.
    expect(resolveRunCredentialSource({ ownerCredentialPresent: false, serverKeyPresent: true, missingSelectedKind: true }))
      .toEqual({ source: "none", reason: "missing_selected_kind" });
    expect(resolveRunCredentialSource({ ownerCredentialPresent: false, serverKeyPresent: false, missingSelectedKind: true }))
      .toEqual({ source: "none", reason: "missing_selected_kind" });
  });
});

describe("credential kinds", () => {
  it("allows a subscription kind only where one is actually honored", () => {
    expect(credentialKindsForProvider("anthropic")).toEqual(["api_key", "oauth"]);
    // openai's ChatGPT-bundle kind is withheld until §5 ships (Spike D):
    // don't offer a connection every run of which would 503.
    expect(credentialKindsForProvider("openai")).toEqual(["api_key"]);
    expect(credentialKindsForProvider("kimi")).toEqual(["api_key"]);
    expect(credentialKindsForProvider("gemini")).toEqual(["api_key"]);
    expect(credentialKindsForProvider("glm")).toEqual(["api_key"]);
  });

  it("parses kinds strictly", () => {
    expect(parseCredentialKind("api_key")).toBe("api_key");
    expect(parseCredentialKind("oauth")).toBe("oauth");
    expect(parseCredentialKind("subscription")).toBeNull();
    expect(parseCredentialKind(undefined)).toBeNull();
  });

  it("keeps the legacy AAD shape for api_key rows and binds the kind for new ones", () => {
    expect(credentialAadContext("user-1", "anthropic", "api_key")).toBe("user-1:anthropic");
    expect(credentialAadContext("user-1", "anthropic", "oauth")).toBe("user-1:anthropic:oauth");
    expect(credentialAadContext("user-1", "openai", "oauth")).toBe("user-1:openai:oauth");
  });

  it("labels kinds for Settings rows and refusal messages", () => {
    expect(credentialKindLabel("anthropic", "api_key")).toBe("API key");
    expect(credentialKindLabel("anthropic", "oauth")).toBe("Claude subscription");
    expect(credentialKindLabel("openai", "oauth")).toBe("ChatGPT subscription");
  });
});

describe("connect-time key validation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the deterministic test adapter without touching the network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const accepted = await validateProviderApiKey("anthropic", "sk-ant-good", { testAcceptedKeys: { anthropic: ["sk-ant-good"] } });
    const rejected = await validateProviderApiKey("anthropic", "sk-ant-bad", { testAcceptedKeys: { anthropic: ["sk-ant-good"] } });
    const otherProvider = await validateProviderApiKey("openai", "sk-ant-good", { testAcceptedKeys: { anthropic: ["sk-ant-good"] } });
    expect(accepted).toEqual({ ok: true });
    expect(rejected).toEqual({ ok: false, reason: "unauthorized" });
    expect(otherProvider).toEqual({ ok: false, reason: "unauthorized" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends provider-correct auth headers to the models endpoint", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      return new Response("{}", { status: 200 });
    });
    expect(await validateProviderApiKey("anthropic", "sk-ant-key")).toEqual({ ok: true });
    expect(await validateProviderApiKey("openai", "sk-openai-key")).toEqual({ ok: true });
    expect(await validateProviderApiKey("glm", "zai-key")).toEqual({ ok: true });
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/models");
    expect(calls[0].headers["x-api-key"]).toBe("sk-ant-key");
    expect(calls[0].headers["anthropic-version"]).toBeTruthy();
    expect(calls[1].url).toBe("https://api.openai.com/v1/models");
    expect(calls[1].headers.authorization).toBe("Bearer sk-openai-key");
    expect(calls[2].url).toBe("https://api.z.ai/api/paas/v4/models");
    expect(calls[2].headers.authorization).toBe("Bearer zai-key");
  });

  it("validates a setup token against GET /v1/models with a plain Bearer — anthropic only", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      return new Response("{}", { status: 200 });
    });
    expect(await validateProviderOauthSecret("anthropic", "sk-ant-oat01-tok")).toEqual({ ok: true });
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/models");
    expect(calls[0].headers.authorization).toBe("Bearer sk-ant-oat01-tok");
    expect(calls[0].headers["anthropic-version"]).toBeTruthy();
    // No beta flag is needed for validation (Spike C rerun) — none is sent.
    expect(calls[0].headers["anthropic-beta"]).toBeUndefined();
    // No other provider has a free oauth probe: null, and no network call —
    // the caller stores validated_at null instead of faking a timestamp.
    expect(await validateProviderOauthSecret("openai", "bundle-json")).toBeNull();
    expect(await validateProviderOauthSecret("kimi", "token")).toBeNull();
    expect(calls).toHaveLength(1);
    // The deterministic adapter covers oauth the same way it covers keys.
    expect(await validateProviderOauthSecret("anthropic", "sk-good", { testAcceptedKeys: { anthropic: ["sk-good"] } })).toEqual({ ok: true });
    expect(await validateProviderOauthSecret("anthropic", "sk-bad", { testAcceptedKeys: { anthropic: ["sk-good"] } })).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("maps provider rejection and unreachability to distinct reasons", async () => {
    vi.stubGlobal("fetch", async () => new Response("no", { status: 401 }));
    expect(await validateProviderApiKey("anthropic", "sk-ant-key")).toEqual({ ok: false, reason: "unauthorized" });
    vi.stubGlobal("fetch", async () => new Response("boom", { status: 500 }));
    expect(await validateProviderApiKey("anthropic", "sk-ant-key")).toEqual({ ok: false, reason: "unreachable" });
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    expect(await validateProviderApiKey("anthropic", "sk-ant-key")).toEqual({ ok: false, reason: "unreachable" });
  });
});
