import type { CredentialProvider } from "@/lib/provider-credentials";

// Connect-time key validation against the provider's free models listing.
// `testAcceptedKeys` is the deterministic test adapter (same convention as
// GitHubAppConfig.testData): when present, no network call is made and a key
// is valid exactly when listed for its provider.

export type ProviderKeyCheck = { ok: true } | { ok: false; reason: "unauthorized" | "unreachable" };

export type ProviderValidationOptions = {
  testAcceptedKeys?: Partial<Record<CredentialProvider, string[]>> | null;
};

export async function validateProviderApiKey(
  provider: CredentialProvider,
  apiKey: string,
  options: ProviderValidationOptions = {},
): Promise<ProviderKeyCheck> {
  if (options.testAcceptedKeys) {
    return options.testAcceptedKeys[provider]?.includes(apiKey)
      ? { ok: true }
      : { ok: false, reason: "unauthorized" };
  }
  const requests: Record<CredentialProvider, { url: string; headers: Record<string, string> }> = {
    anthropic: { url: "https://api.anthropic.com/v1/models", headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } },
    openai: { url: "https://api.openai.com/v1/models", headers: { authorization: `Bearer ${apiKey}` } },
    kimi: { url: "https://api.moonshot.ai/v1/models", headers: { authorization: `Bearer ${apiKey}` } },
    gemini: { url: "https://generativelanguage.googleapis.com/v1beta/models", headers: { "x-goog-api-key": apiKey } },
    glm: { url: "https://api.z.ai/api/paas/v4/models", headers: { authorization: `Bearer ${apiKey}` } },
    // International (Singapore) endpoint, the same upstream the qwen gateway
    // forwards to; a China-region key fails here by design.
    qwen: { url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models", headers: { authorization: `Bearer ${apiKey}` } },
    deepseek: { url: "https://api.deepseek.com/models", headers: { authorization: `Bearer ${apiKey}` } },
  };
  const request = requests[provider];
  return probeModelsEndpoint(request.url, request.headers);
}

// Subscription-credential validation. A Claude setup token authenticates
// GET /v1/models with a plain Bearer header — no beta flag needed (Spike C
// rerun, 2026-08-24) — so anthropic oauth credentials get a real
// validated_at on connect. No other provider has a free oauth probe today
// (a ChatGPT auth bundle has none); null means "no probe exists" and the
// caller stores validated_at null rather than faking a timestamp.
export async function validateProviderOauthSecret(
  provider: CredentialProvider,
  secret: string,
  options: ProviderValidationOptions = {},
): Promise<ProviderKeyCheck | null> {
  if (provider !== "anthropic") return null;
  if (options.testAcceptedKeys) {
    return options.testAcceptedKeys[provider]?.includes(secret)
      ? { ok: true }
      : { ok: false, reason: "unauthorized" };
  }
  return probeModelsEndpoint("https://api.anthropic.com/v1/models", {
    authorization: `Bearer ${secret}`,
    "anthropic-version": "2023-06-01",
  });
}

async function probeModelsEndpoint(url: string, headers: Record<string, string>): Promise<ProviderKeyCheck> {
  try {
    const response = await fetch(url, { method: "GET", headers });
    if (response.ok) return { ok: true };
    if (response.status === 401 || response.status === 403) return { ok: false, reason: "unauthorized" };
    return { ok: false, reason: "unreachable" };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}
