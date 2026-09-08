// Pure provider-credential types and decisions. No cloudflare:workers import —
// this module is shared by client components and unit tests (same rule as
// lib/plans.ts). Persistence lives in db/provider-credentials.ts.

// Grok (xAI) is deliberately absent — three routes closed: its Anthropic-compat
// endpoint rejects the CLI's system-role messages (2026-08-24, reconfirmed
// 2026-08-26), its Responses API rejects the "content": null Codex writes on
// replayed reasoning items (2026-08-24, reconfirmed at codex-sdk 0.149.1 on
// 2026-08-26, where effort "none" is also vendor-rejected), and the chat wire
// is hard-refused by the pinned Codex binary itself (`wire_api = "chat"` is
// no longer supported — verified 2026-08-26). See the AGENTS.md decision log
// before proposing route four.
// qwen (Alibaba Cloud Model Studio / DashScope) and deepseek ride one shared
// Qwen Code CLI runner against an OpenAI-chat-completions gateway each — see
// usesQwenRunner below and docs/qwen-deepseek-provider-prompt.md (Spike Q1,
// 2026-08-28).
export const CREDENTIAL_PROVIDERS = ["anthropic", "openai", "kimi", "gemini", "glm", "qwen", "deepseek"] as const;
export type CredentialProvider = (typeof CREDENTIAL_PROVIDERS)[number];

// A subscription credential (Claude setup token, ChatGPT auth bundle, Kimi
// Code plan key) is stored under the same (user_id, provider) identity as an
// API key; `kind` says how to use it. The row key is (user_id, provider,
// kind), so a user can hold both for one provider and each agent names which
// one pays. `oauth` is the second-credential slot — "the member's own
// subscription seat" — not a claim about the token's protocol (a Kimi Code
// plan key is not an OAuth token in any literal sense).
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
// anthropic: Claude setup tokens, fully spike-verified (2026-08-24).
// kimi: a Kimi Code plan key, minted in the vendor's plan console — shipped
// on the vendor's own documented surface without a purchased-plan spike
// (waitlist blocked the purchase; 2026-08-26 decision-log entry) and
// validated by production members' runs.
// openai: a ChatGPT `~/.codex/auth.json` bundle. Withheld on 2026-08-25 while
// Spike D was unrun; Spike D PASSED on 2026-08-26 and the kind is now live.
// The gateway substitutes the bundle's access token toward
// chatgpt.com/backend-api/codex, so the run container never holds the
// credential at all — see the 2026-08-26 ENG-117 decision-log entry.
// qwen: api_key only. Alibaba's Coding Plan (sk-sp-… keys on a separate
// coding-intl base) is the natural oauth-kind candidate, withheld until Spike
// Q2 completes a run on a real plan key — the Kimi precedent shipped a plan
// surface unverified; do not repeat that silently.
export function credentialKindsForProvider(provider: CredentialProvider): readonly CredentialKind[] {
  return provider === "anthropic" || provider === "kimi" || provider === "openai" ? CREDENTIAL_KINDS : ["api_key"];
}

// Supported subscription parsers and gateways remain available for a future
// acceptance rollout, but product connections and runs currently accept API keys only.
export function availableCredentialKinds(_provider: CredentialProvider): readonly CredentialKind[] {
  return credentialKindsForProvider(_provider).filter((kind) => kind === "api_key");
}

// Deduped: a provider can hold two credential rows (api_key + oauth) — it is
// still one connected provider, not two options with the same value (which
// also collide as React keys in a listbox). Shared by the create-agent
// dialog and the auto-agent provider pickers (AgentFloor, SessionScreen) so
// the dedupe-and-filter rule lives in exactly one place.
export function connectedProviders(
  credentials: readonly ProviderCredentialSummary[],
  enabled: readonly CredentialProvider[],
): CredentialProvider[] {
  return [...new Set(credentials.filter((credential) => credential.kind === "api_key").map((credential) => credential.provider))].filter((provider) =>
    enabled.includes(provider),
  );
}

// Kinds the user has actually connected for one provider, intersected with
// the kinds that provider accepts (defense in depth against a hand-written
// row of a kind the provider was never meant to offer).
export function connectedKindsForProvider(
  credentials: readonly ProviderCredentialSummary[],
  provider: CredentialProvider,
): CredentialKind[] {
  const accepted = availableCredentialKinds(provider);
  const connected = new Set(
    credentials.filter((credential) => credential.provider === provider).map((credential) => credential.kind),
  );
  return accepted.filter((kind) => connected.has(kind));
}

// "API key" / "Claude subscription" / "Kimi Code subscription" — used by
// Settings rows and gateway refusal messages, so each must be a name the
// member recognizes from their invoice.
export function credentialKindLabel(provider: CredentialProvider, kind: CredentialKind): string {
  if (kind === "api_key") return "API key";
  return provider === "anthropic" ? "Claude subscription"
    : provider === "openai" ? "ChatGPT subscription"
    : provider === "kimi" ? "Kimi Code subscription"
    : "subscription";
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
  // This-UTC-month spend against this exact credential (from
  // provider_spend_months) and the owner-set cap it's checked against
  // (lib/agent-run-start.ts's checkProviderBudget). Null limit means no cap
  // set — the meter still shows spend, just with no ceiling to warn against.
  monthSpendMicroUsd: number;
  monthlyLimitMicroUsd: number | null;
  // Same-month token totals from the same rollup row. Input and output only —
  // cache tokens are metered into cost but not rolled up per month.
  monthInputTokens: number;
  monthOutputTokens: number;
};

// One row of provider_spend_months for the current UTC month, as the model
// usage views on Home and Settings read it. kind "server" is openfloor's
// fallback key — it has no credential row, so it only ever surfaces here.
export type MonthlyProviderUsage = {
  provider: CredentialProvider;
  kind: CredentialKind | "server";
  microUsd: number;
  inputTokens: number;
  outputTokens: number;
};

export function monthlyUsageLabel(row: Pick<MonthlyProviderUsage, "provider" | "kind">): string {
  const kind = row.kind === "server" ? "openfloor key" : credentialKindLabel(row.provider, row.kind);
  return `${providerLabel(row.provider)} · ${kind}`;
}

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
  qwen: "Alibaba Cloud",
  deepseek: "DeepSeek",
};

/* What Settings shows next to each provider: a mark, where the key is made,
   and the shape a real key has. The placeholder is the whole point of the
   last one — a pasted key that does not look like the example is almost
   always the wrong vendor's. Z.ai, Alibaba Cloud, and DeepSeek have no mark
   in public/logos yet, so their tiles fall back to a monogram. */
export const PROVIDER_LOGOS: Record<CredentialProvider, string | null> = {
  anthropic: "/logos/anthropic.svg",
  openai: "/logos/openai.svg",
  kimi: "/logos/kimi.svg",
  gemini: "/logos/gemini.svg",
  glm: null,
  qwen: null,
  deepseek: null,
};

export const PROVIDER_KEY_GUIDE: Record<CredentialProvider, { placeholder: string; consoleUrl: string; consoleLabel: string }> = {
  anthropic: { placeholder: "sk-ant-api03-…", consoleUrl: "https://console.anthropic.com/settings/keys", consoleLabel: "Anthropic Console" },
  openai: { placeholder: "sk-proj-…", consoleUrl: "https://platform.openai.com/api-keys", consoleLabel: "OpenAI Platform" },
  kimi: { placeholder: "sk-…", consoleUrl: "https://platform.moonshot.ai/console/api-keys", consoleLabel: "Moonshot Platform" },
  gemini: { placeholder: "AIza…", consoleUrl: "https://aistudio.google.com/apikey", consoleLabel: "Google AI Studio" },
  glm: { placeholder: "…", consoleUrl: "https://z.ai/manage-apikey/apikey-list", consoleLabel: "Z.ai console" },
  // Singapore region on purpose: the gateway's upstream is the international
  // (dashscope-intl) endpoint, and a Beijing-region key does not authenticate
  // there. Keys are "sk-…" (newer ones "sk-ws…"); an "sk-sp-…" key is a Coding
  // Plan key, a different surface (see credentialKindsForProvider).
  qwen: { placeholder: "sk-…", consoleUrl: "https://modelstudio.console.alibabacloud.com/ap-southeast-1?tab=model#/api-key", consoleLabel: "Model Studio console" },
  deepseek: { placeholder: "sk-…", consoleUrl: "https://platform.deepseek.com/api_keys", consoleLabel: "DeepSeek Platform" },
};

// The command that mints a subscription credential on the member's own
// machine. Rendered with a copy button rather than as prose, because it is
// meant to be pasted, and only for the kinds that have one. Kimi has no
// entry on purpose: a Kimi Code plan key is minted on a console page, not by
// a CLI — the Settings form branches on this absence.
export const CREDENTIAL_SETUP_COMMANDS: Partial<Record<`${CredentialProvider}:${CredentialKind}`, string>> = {
  "anthropic:oauth": "claude setup-token",
  "openai:oauth": "codex login",
};

// Where a subscription credential is minted when it comes from a console page
// rather than a CLI command — a different console than the provider's PAYG
// key console in PROVIDER_KEY_GUIDE (Kimi Code keys live on kimi.com, not
// platform.moonshot.ai).
export const SUBSCRIPTION_KEY_GUIDE: Partial<Record<CredentialProvider, { consoleUrl: string; consoleLabel: string }>> = {
  kimi: { consoleUrl: "https://www.kimi.com/code", consoleLabel: "Kimi Code Console" },
};

// Where a member asks for a provider openfloor does not carry yet.
export const CONNECTION_REQUEST_EMAIL = "hello@opnflr.com";

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
  qwen: "Qwen",
  deepseek: "DeepSeek",
};

// Providers whose runs execute through scripts/claude-runner.mjs against an
// Anthropic-Messages-compatible gateway route — the single predicate every
// workflow branch keys on. Gemini has its own runner; openai is Codex;
// qwen/deepseek share the Qwen Code runner (usesQwenRunner).
export function usesClaudeRunner(provider: CredentialProvider): boolean {
  return provider === "anthropic" || provider === "kimi" || provider === "glm";
}

// Providers whose runs execute through scripts/qwen-runner.mjs (the pinned
// Qwen Code CLI, which speaks OpenAI chat completions) against an
// OpenAI-chat-compat gateway route — /runtime/qwen or /runtime/deepseek. The
// only difference between the two is the gateway the run JWT is bound to,
// exactly the Kimi→GLM recipe; every workflow branch keys on this predicate,
// never on the id.
export function usesQwenRunner(provider: CredentialProvider): boolean {
  return provider === "qwen" || provider === "deepseek";
}

// Providers whose runner can continue an earlier attempt's thread from a
// persisted session store (worker/agent-run-workflow.ts persistSessionStore /
// restore, lib/run-resume.ts): Codex (`~/.codex/sessions`), the Claude
// runner (`~/.claude/projects`), and the Qwen Code runner
// (`~/.qwen/projects`, verified Spike Q1 step 4). Gemini is the exclusion —
// its pinned CLI's resume support is unverified.
export function resumableProvider(provider: CredentialProvider): boolean {
  return provider !== "gemini";
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
//   "kimi-k3[1m]" alias is NOT an API id (404, verified in Spike A). The
//   plan-surface ids (kimi-for-coding, kimi-for-coding-highspeed, k3-256k)
//   are banked from the vendor's Kimi Code docs, not an endpoint read (the
//   plan waitlist blocked a purchase — 2026-08-26 decision-log entry); a
//   subscription-bound agent must pick one, since the plan base almost
//   certainly does not serve the PAYG ids. The per-credential mismatch
//   surfaces as the vendor's own error, the accepted limit above.
// gemini: curated to ids that actually reach the wire — the pinned CLI
//   rewrites some newer ids through its own resolution table
//   (gemini-3.7-flash → gemini-3.5-flash at pin 0.56.0), and the DB model
//   column must record what runs, so those rewritten ids are excluded.
// glm: ids Z.ai's /api/paas/v4/models endpoint returns (Spike A,
//   2026-08-24); marketing names are not API ids.
// openai: the models-endpoint read stayed blocked on a key at the banking
//   pass; until one exists this stays the single known-good default —
//   gpt-5.6 variants must not be guessed.
// qwen: banked from Model Studio's international model list and pricing pages
//   (2026-08-28, docs/qwen-deepseek-provider-prompt.md) — the coder trio the
//   Coding Plan also serves, plus the two general flagships. NOT yet read
//   from GET /models with a live key (Spike Q2 pending a scratch key); the
//   default was chosen from the vendor's own Qwen Code recommendation, not
//   from a run. Re-verify at Spike Q2 before flipping QWEN_RUN_ENABLED.
// deepseek: the two ids GET /models returns per the vendor's docs
//   (2026-08-28) — deepseek-chat/deepseek-reasoner are no longer listed.
//   Same caveat: Spike D1 re-reads the endpoint before the flag flips.
export const PROVIDER_MODELS: Record<CredentialProvider, readonly string[]> = {
  openai: ["gpt-5.6-terra"],
  anthropic: ["claude-opus-5", "claude-fable-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"],
  kimi: ["kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6", "kimi-for-coding", "kimi-for-coding-highspeed", "k3-256k"],
  gemini: ["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
  glm: ["glm-5.3", "glm-5.2", "glm-5.1", "glm-5-turbo", "glm-5", "glm-4.7", "glm-4.6", "glm-4.5-air", "glm-4.5"],
  qwen: ["qwen3-coder-plus", "qwen3-coder-next", "qwen3-coder-flash", "qwen3.7-plus", "qwen3.8-max"],
  deepseek: ["deepseek-v4-pro", "deepseek-v4-flash"],
};

// Derived alias (first allowlist entry), kept so existing importers don't
// churn — but there is deliberately only ONE editable list above; a unit
// test pins PROVIDER_MODELS[p][0] === DEFAULT_PROVIDER_MODELS[p] so the two
// names can never drift apart.
export const DEFAULT_PROVIDER_MODELS = Object.fromEntries(
  CREDENTIAL_PROVIDERS.map((provider) => [provider, PROVIDER_MODELS[provider][0]]),
) as Record<CredentialProvider, string>;

// Context-window sizes in tokens, only for models whose window is documented
// somewhere this file can cite: the anthropic note above (claude-haiku-4-5 is
// the 200K entry, the rest are 1M), k3-256k's own vendor id, the top of each
// Qwen model's published input-length pricing tier (Model Studio international
// pricing, 2026-08-28), and DeepSeek's documented 1M for both V4 ids. Absent
// means unknown — the UI shows a plain token count, never a guessed meter.
// Extend alongside PROVIDER_MODELS when a vendor documents a window.
export const MODEL_CONTEXT_TOKENS: Record<string, number> = {
  "claude-opus-5": 1_000_000,
  "claude-fable-5": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-haiku-4-5": 200_000,
  "k3-256k": 256_000,
  "qwen3-coder-plus": 1_000_000,
  "qwen3-coder-next": 256_000,
  "qwen3-coder-flash": 1_000_000,
  "qwen3.7-plus": 1_000_000,
  "qwen3.8-max": 1_000_000,
  "deepseek-v4-pro": 1_000_000,
  "deepseek-v4-flash": 1_000_000,
};

export function resolveRunModel(provider: CredentialProvider, agentModel: string | null): string {
  const model = agentModel?.trim();
  return model || DEFAULT_PROVIDER_MODELS[provider];
}

export type RunCredentialResolution =
  | { source: "owner" }
  | { source: "none"; reason: "no_credential" | "missing_selected_kind" };

// Only the agent owner's personal API key may fund a run. Legacy server-key
// input remains accepted for callers and regression tests, but is never used.
export function resolveRunCredentialSource(input: {
  ownerCredentialPresent: boolean;
  serverKeyPresent: boolean;
  missingSelectedKind?: boolean;
}): RunCredentialResolution {
  if (input.missingSelectedKind) return { source: "none", reason: "missing_selected_kind" };
  if (input.ownerCredentialPresent) return { source: "owner" };
  return { source: "none", reason: "no_credential" };
}
