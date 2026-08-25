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
  };
  const request = requests[provider];
  try {
    const response = await fetch(request.url, { method: "GET", headers: request.headers });
    if (response.ok) return { ok: true };
    if (response.status === 401 || response.status === 403) return { ok: false, reason: "unauthorized" };
    return { ok: false, reason: "unreachable" };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}
