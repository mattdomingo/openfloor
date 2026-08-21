// Pure provider-credential types and decisions. No cloudflare:workers import —
// this module is shared by client components and unit tests (same rule as
// lib/plans.ts). Persistence lives in db/provider-credentials.ts.

export const CREDENTIAL_PROVIDERS = ["anthropic", "openai"] as const;
export type CredentialProvider = (typeof CREDENTIAL_PROVIDERS)[number];

// ponytail: "api_key" is the only kind until Anthropic approves third-party
// OAuth for openfloor; a future kind:"oauth" reuses the same row identity.
export type CredentialKind = "api_key";

export type ProviderCredentialSummary = {
  provider: CredentialProvider;
  kind: CredentialKind;
  fingerprint: string;
  validatedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export function parseCredentialProvider(value: unknown): CredentialProvider | null {
  return CREDENTIAL_PROVIDERS.includes(value as CredentialProvider) ? (value as CredentialProvider) : null;
}

export function providerLabel(provider: CredentialProvider): string {
  return provider === "anthropic" ? "Anthropic" : "OpenAI";
}

// Stored and shown instead of the key itself; routes never return the key.
export function credentialFingerprint(apiKey: string): string {
  return apiKey.slice(-4);
}

// Per-provider default models, replacing the old single AGENT_RUN_MODEL
// constant. A floor agent's nullable `model` column overrides its provider's
// default; today no API accepts a model, so every run uses these.
export const DEFAULT_PROVIDER_MODELS: Record<CredentialProvider, string> = {
  openai: "gpt-5.6-terra",
  anthropic: "claude-opus-5",
};

export function resolveRunModel(provider: CredentialProvider, agentModel: string | null): string {
  const model = agentModel?.trim();
  return model || DEFAULT_PROVIDER_MODELS[provider];
}

export type RunCredentialResolution = { source: "owner" } | { source: "server" } | { source: "none" };

// Per-run resolution order: the session owner's connected credential for the
// run's provider, else the server-configured key, else refuse the run. Owner
// rather than run initiator because the owner is who the plan quota bills.
// Never falls back from a present-but-failing owner credential to the server
// key — a broken key must surface as a run failure, not silently switch payer.
export function resolveRunCredentialSource(input: {
  ownerCredentialPresent: boolean;
  serverKeyPresent: boolean;
}): RunCredentialResolution {
  if (input.ownerCredentialPresent) return { source: "owner" };
  if (input.serverKeyPresent) return { source: "server" };
  return { source: "none" };
}
