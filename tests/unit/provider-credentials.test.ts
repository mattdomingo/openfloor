import { afterEach, describe, expect, it, vi } from "vitest";
import {
  credentialFingerprint,
  DEFAULT_PROVIDER_MODELS,
  parseCredentialProvider,
  providerLabel,
  resolveRunCredentialSource,
  resolveRunModel,
} from "@/lib/provider-credentials";
import { validateProviderApiKey } from "@/lib/provider-validation";

describe("provider parsing and labels", () => {
  it("accepts only known providers", () => {
    expect(parseCredentialProvider("anthropic")).toBe("anthropic");
    expect(parseCredentialProvider("openai")).toBe("openai");
    expect(parseCredentialProvider("gemini")).toBeNull();
    expect(parseCredentialProvider("")).toBeNull();
    expect(parseCredentialProvider(undefined)).toBeNull();
  });

  it("labels providers for people", () => {
    expect(providerLabel("anthropic")).toBe("Anthropic");
    expect(providerLabel("openai")).toBe("OpenAI");
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
  });

  it("keeps the Codex default the historical AGENT_RUN_MODEL value", () => {
    expect(DEFAULT_PROVIDER_MODELS.openai).toBe("gpt-5.6-terra");
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

  it("refuses when neither exists", () => {
    expect(resolveRunCredentialSource({ ownerCredentialPresent: false, serverKeyPresent: false })).toEqual({ source: "none" });
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
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/models");
    expect(calls[0].headers["x-api-key"]).toBe("sk-ant-key");
    expect(calls[0].headers["anthropic-version"]).toBeTruthy();
    expect(calls[1].url).toBe("https://api.openai.com/v1/models");
    expect(calls[1].headers.authorization).toBe("Bearer sk-openai-key");
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
