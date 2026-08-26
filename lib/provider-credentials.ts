// Pure provider-credential types and decisions. No cloudflare:workers import —
// this module is shared by client components and unit tests (same rule as
// lib/plans.ts). Persistence lives in db/provider-credentials.ts.

// Grok (xAI) is deliberately absent — twice over: its Anthropic-compat
// endpoint rejects the CLI's system-role messages, and its Responses API
// rejects the "content": null Codex writes on replayed reasoning items
// (both 2026-08-24 — see the AGENTS.md decision log), so no runner can
// serve it today.
export const CREDENTIAL_PROVIDERS = ["anthropic", "openai", "kimi", "gemini", "glm"] as const;
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
// openai's oauth kind (a ChatGPT auth bundle) is deliberately WITHHELD until
// the brief's §5 ships (gated on Spike D): the parse shape and the dormant
// Settings form remain §5-ready, but offering a connection no run can honor
// would only manufacture 503s. The openai gateway keeps its own oauth-kind
// refusal as defense in depth for hand-written rows.
export function credentialKindsForProvider(provider: CredentialProvider): readonly CredentialKind[] {
  return provider === "anthropic" ? CREDENTIAL_KINDS : ["api_key"];
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
  glm: "Z.ai",
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
  glm: "GLM",
};

// Providers whose runs execute through scripts/claude-runner.mjs against an
// Anthropic-Messages-compatible gateway route — the single predicate every
// workflow branch keys on. Gemini has its own runner; openai is Codex.
export function usesClaudeRunner(provider: CredentialProvider): boolean {
  return provider === "anthropic" || provider === "kimi" || provider === "glm";
}

// Stored and shown instead of the key itself; routes never return the key.
export function credentialFingerprint(apiKey: string): string {
  return apiKey.slice(-4);
}

// Per-provider closed model allowlists; the FIRST entry is the provider's
// default (the old DEFAULT_PROVIDER_MODELS values, unchanged). A floor
// agent's nullable `model` column picks one; parseAgentInput and the
// settings PATCH validate against this set so an unknown id is a 400 at
// input time, never a vendor 404 mid-run. Ids were banked from each
// vendor's models endpoint (docs/glm-grok-subscription-provider-prompt.md,
// Step 0, 2026-08-24/25) — prefer an undated alias wherever one resolves,
// because a dated snapshot 404s when it retires.
//
// Two accepted limits, stated rather than engineered around: the list goes
// stale (a new model is a one-line edit here, not a broken run — do NOT
// fetch /v1/models at dialog render), and it is per provider, not per
// credential (a plan that lacks a model surfaces as the vendor's own error
// at run start; openfloor has no source for plan entitlements).
//
// anthropic: never append a date suffix — the undated aliases resolve and
//   outlive snapshot retirement. claude-haiku-4-5 is the only 200K-context
//   entry (the rest are 1M); claude-fable-5 is unavailable under zero data
//   retention, so a ZDR-configured org gets a 400 instead of a run.
//   claude-mythos-5 is invitation-only and deliberately excluded.
// kimi: bare "kimi-k3" — Moonshot's /v1/models id; the Claude-Code-doc
//   "kimi-k3[1m]" alias is NOT an API id (404, verified in Spike A).
// gemini: curated to ids that actually reach the wire — the pinned CLI
//   rewrites some newer ids through its own resolution table
//   (gemini-3.7-flash → gemini-3.5-flash at pin 0.56.0), and the DB model
//   column must record what runs, so those rewritten ids are excluded.
// glm: ids Z.ai's /api/paas/v4/models endpoint returns (Spike A,
//   2026-08-24); marketing names are not API ids.
// openai: the models-endpoint read stayed blocked on a key at the banking
//   pass; until one exists this stays the single known-good default —
//   gpt-5.6 variants must not be guessed.
export const PROVIDER_MODELS: Record<CredentialProvider, readonly string[]> = {
  openai: ["gpt-5.6-terra"],
  anthropic: ["claude-opus-5", "claude-fable-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"],
  kimi: ["kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6"],
  gemini: ["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
  glm: ["glm-5.3", "glm-5.2", "glm-5.1", "glm-5-turbo", "glm-5", "glm-4.7", "glm-4.6", "glm-4.5-air", "glm-4.5"],
};

// Derived alias (first allowlist entry), kept so existing importers don't
// churn — but there is deliberately only ONE editable list above; a unit
// test pins PROVIDER_MODELS[p][0] === DEFAULT_PROVIDER_MODELS[p] so the two
// names can never drift apart.
export const DEFAULT_PROVIDER_MODELS = Object.fromEntries(
  CREDENTIAL_PROVIDERS.map((provider) => [provider, PROVIDER_MODELS[provider][0]]),
) as Record<CredentialProvider, string>;

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
