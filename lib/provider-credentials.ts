// Pure provider-credential types and decisions. No cloudflare:workers import —
// this module is shared by client components and unit tests (same rule as
// lib/plans.ts). Persistence lives in db/provider-credentials.ts.

// Grok (xAI) is deliberately absent: its Anthropic-compat endpoint rejects
// the system-role messages the Claude Code CLI sends (Spike B, 2026-08-24 —
// see the AGENTS.md decision log), so no runner can serve it today.
export const CREDENTIAL_PROVIDERS = ["anthropic", "openai", "kimi", "gemini"] as const;
export type CredentialProvider = (typeof CREDENTIAL_PROVIDERS)[number];

// A subscription credential (Claude setup token, ChatGPT auth bundle) is
// stored under the same (user_id, provider) identity as an API key; `kind`
// says how to use it. The row key is (user_id, provider, kind), so a user can
// hold both for one provider and each agent names which one pays.
export const CREDENTIAL_KINDS = ["api_key", "oauth"] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

export function parseCredentialKind(value: unknown): CredentialKind | null {
  return CREDENTIAL_KINDS.includes(value as CredentialKind) ? (value as CredentialKind) : null;
}

// Which kinds a provider accepts. Enforced at the credentials PUT route AND at
// gateway resolution, so a hand-written row can never get a Claude
// subscription token sent to another vendor. Server fallback credentials are
// always api_key by construction (plain string bindings) — openfloor never
// operates one person's subscription seat on behalf of others.
export function credentialKindsForProvider(provider: CredentialProvider): readonly CredentialKind[] {
  return provider === "anthropic" || provider === "openai" ? CREDENTIAL_KINDS : ["api_key"];
}

// "API key" / "Claude subscription" / "ChatGPT subscription" — used by
// Settings rows and gateway refusal messages.
export function credentialKindLabel(provider: CredentialProvider, kind: CredentialKind): string {
  if (kind === "api_key") return "API key";
  return provider === "anthropic" ? "Claude subscription" : provider === "openai" ? "ChatGPT subscription" : "subscription";
}

// AAD context for lib/credential-crypto.ts. api_key keeps the bare legacy
// "<userId>:<provider>" shape so every existing row stays decryptable without
// a reconnect; new kinds bind the kind too, because with two rows per
// user+provider the bare form no longer identifies a row.
export function credentialAadContext(userId: string, provider: CredentialProvider, kind: CredentialKind): string {
  return kind === "api_key" ? `${userId}:${provider}` : `${userId}:${provider}:${kind}`;
}

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

// Vendor names, used by Settings connections and error strings.
const PROVIDER_LABELS: Record<CredentialProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  kimi: "Moonshot",
  gemini: "Google",
};

export function providerLabel(provider: CredentialProvider): string {
  return PROVIDER_LABELS[provider];
}

// Short agent/run names, used by AgentCard and the create-agent dialog
// (rendered as `${AGENT_PROVIDER_LABELS[p]} (${providerLabel(p)})`).
export const AGENT_PROVIDER_LABELS: Record<CredentialProvider, string> = {
  anthropic: "Claude",
  openai: "Codex",
  kimi: "Kimi",
  gemini: "Gemini",
};

// Providers whose runs execute through scripts/claude-runner.mjs against an
// Anthropic-Messages-compatible gateway route — the single predicate every
// workflow branch keys on. Gemini has its own runner; openai is Codex.
export function usesClaudeRunner(provider: CredentialProvider): boolean {
  return provider === "anthropic" || provider === "kimi";
}

// Stored and shown instead of the key itself; routes never return the key.
export function credentialFingerprint(apiKey: string): string {
  return apiKey.slice(-4);
}

// Per-provider default models, replacing the old single AGENT_RUN_MODEL
// constant. A floor agent's nullable `model` column overrides its provider's
// default; today no API accepts a model, so every run uses these.
// kimi: bare "kimi-k3" — Moonshot's /v1/models id; the Claude-Code-doc
// "kimi-k3[1m]" alias is NOT an API id (404, verified in Spike A).
// gemini: "gemini-3.5-flash" — the id the pinned CLI actually sends; it
// rewrites newer flash ids (e.g. gemini-3.7-flash) to this one (Spike C).
export const DEFAULT_PROVIDER_MODELS: Record<CredentialProvider, string> = {
  openai: "gpt-5.6-terra",
  anthropic: "claude-opus-5",
  kimi: "kimi-k3",
  gemini: "gemini-3.5-flash",
};

export function resolveRunModel(provider: CredentialProvider, agentModel: string | null): string {
  const model = agentModel?.trim();
  return model || DEFAULT_PROVIDER_MODELS[provider];
}

export type RunCredentialResolution =
  | { source: "owner" }
  | { source: "server" }
  | { source: "none"; reason: "no_credential" | "missing_selected_kind" };

// Per-run resolution order: the agent owner's connected credential for the
// run's provider, else the server-configured key, else refuse the run. The
// agent's owner (chosen in the create-agent dialog) rather than the session
// owner or run initiator: whoever provisions an agent is whose API usage its
// runs bill. Plan quota (session hours) still bills the session owner —
// deliberately separate ledgers. Never falls back from a present-but-failing
// owner credential to the server key — a broken key must surface as a run
// failure, not silently switch payer. When the agent names a credential kind
// the owner has not connected, the run refuses even if a server key exists:
// billing a payer the agent did not name is the same failure in a different
// costume, and the distinguishable reason lets the gateway say which
// connection is missing instead of the generic refusal.
export function resolveRunCredentialSource(input: {
  ownerCredentialPresent: boolean;
  serverKeyPresent: boolean;
  missingSelectedKind?: boolean;
}): RunCredentialResolution {
  if (input.missingSelectedKind) return { source: "none", reason: "missing_selected_kind" };
  if (input.ownerCredentialPresent) return { source: "owner" };
  if (input.serverKeyPresent) return { source: "server" };
  return { source: "none", reason: "no_credential" };
}
