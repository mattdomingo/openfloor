// Per-token list pricing for every model in PROVIDER_MODELS
// (lib/provider-credentials.ts). The only file in the codebase that contains
// per-token money — keep it that way so a price correction is a one-file
// change. Used only to ESTIMATE cost for providers that don't report a
// dollar figure themselves (lib/run-usage.ts); a genuine Anthropic run uses
// the SDK's own total_cost_usd instead (costSource: "reported") and never
// touches this table.
//
// Verified 2026-08-26 against each vendor's own published pricing (Anthropic
// platform.claude.com/docs/en/about-claude/pricing; OpenAI
// developers.openai.com/api/docs/pricing, short-context tier; Moonshot
// platform.kimi.ai/docs/pricing/<model>, cache-miss input; Google
// ai.google.dev/gemini-api/docs/pricing, ≤200k tier where tiered; Z.ai
// docs.z.ai/guides/overview/pricing). `cacheWritePerMTok` uses each vendor's
// 5-minute/default cache-write rate where one is published (Anthropic);
// providers with no separate write charge reuse `inputPerMTok`. GLM's cache
// reads are a time-limited free promotion (`docs.z.ai`) captured here as 0 —
// re-verify before it lapses. Re-verify the whole table on any provider
// price-list change or new model id, the same way
// lib/provider-credentials.ts:129-131 flags the openai model id.
//
// All figures are USD per 1,000,000 tokens.
export type ModelPrice = {
  inputPerMTok: number;
  outputPerMTok: number;
  // Priced separately because a cache hit/write is typically far cheaper (or
  // more expensive, for a write) than a fresh input token. A model with no
  // caching tier reuses inputPerMTok/outputPerMTok for these.
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
};

export const MODEL_PRICING: Record<string, ModelPrice> = {
  // anthropic
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 },
  "claude-fable-5": { inputPerMTok: 10, outputPerMTok: 50, cacheReadPerMTok: 1, cacheWritePerMTok: 12.5 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 },
  "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 },

  // openai (via codex-runner.mjs — always estimated, Codex reports tokens only)
  "gpt-5.6-terra": { inputPerMTok: 2, outputPerMTok: 12, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2 },

  // kimi (Moonshot; rides the Anthropic-Messages-compatible gateway, but
  // must never be priced with claude-opus-5-style "reported" cost — see
  // lib/run-usage.ts)
  "kimi-k3": { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3 },
  "kimi-k2.7-code": { inputPerMTok: 0.95, outputPerMTok: 4, cacheReadPerMTok: 0.19, cacheWritePerMTok: 0.95 },
  "kimi-k2.7-code-highspeed": { inputPerMTok: 1.9, outputPerMTok: 8, cacheReadPerMTok: 0.38, cacheWritePerMTok: 1.9 },
  "kimi-k2.6": { inputPerMTok: 0.95, outputPerMTok: 4, cacheReadPerMTok: 0.16, cacheWritePerMTok: 0.95 },
  // Kimi Code plan-surface ids (2026-08-26 decision-log entry). A plan seat
  // is flat-fee — no per-token invoice exists — so these meter the
  // list-equivalent value of the underlying model's published PAYG rate
  // (kimi-for-coding = K2.7 Code, k3-256k = K3), the same convention an
  // anthropic subscription run already follows via the SDK's list-priced
  // "reported" cost.
  "kimi-for-coding": { inputPerMTok: 0.95, outputPerMTok: 4, cacheReadPerMTok: 0.19, cacheWritePerMTok: 0.95 },
  "kimi-for-coding-highspeed": { inputPerMTok: 1.9, outputPerMTok: 8, cacheReadPerMTok: 0.38, cacheWritePerMTok: 1.9 },
  "k3-256k": { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3 },

  // gemini
  "gemini-3.5-flash": { inputPerMTok: 1.5, outputPerMTok: 9, cacheReadPerMTok: 0.15, cacheWritePerMTok: 1.5 },
  "gemini-3.5-flash-lite": { inputPerMTok: 0.3, outputPerMTok: 2.5, cacheReadPerMTok: 0.03, cacheWritePerMTok: 0.3 },
  "gemini-2.5-pro": { inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.125, cacheWritePerMTok: 1.25 },
  "gemini-2.5-flash": { inputPerMTok: 0.3, outputPerMTok: 2.5, cacheReadPerMTok: 0.03, cacheWritePerMTok: 0.3 },
  "gemini-2.5-flash-lite": { inputPerMTok: 0.1, outputPerMTok: 0.4, cacheReadPerMTok: 0.01, cacheWritePerMTok: 0.1 },

  // glm (Z.ai; also rides the Anthropic-compat gateway — always estimated)
  "glm-5.3": { inputPerMTok: 1.4, outputPerMTok: 4.4, cacheReadPerMTok: 0, cacheWritePerMTok: 1.4 },
  "glm-5.2": { inputPerMTok: 1.4, outputPerMTok: 4.4, cacheReadPerMTok: 0, cacheWritePerMTok: 1.4 },
  "glm-5.1": { inputPerMTok: 1.4, outputPerMTok: 4.4, cacheReadPerMTok: 0, cacheWritePerMTok: 1.4 },
  "glm-5-turbo": { inputPerMTok: 1.2, outputPerMTok: 4, cacheReadPerMTok: 0, cacheWritePerMTok: 1.2 },
  "glm-5": { inputPerMTok: 1, outputPerMTok: 3.2, cacheReadPerMTok: 0, cacheWritePerMTok: 1 },
  "glm-4.7": { inputPerMTok: 0.6, outputPerMTok: 2.2, cacheReadPerMTok: 0, cacheWritePerMTok: 0.6 },
  "glm-4.6": { inputPerMTok: 0.6, outputPerMTok: 2.2, cacheReadPerMTok: 0, cacheWritePerMTok: 0.6 },
  "glm-4.5-air": { inputPerMTok: 0.2, outputPerMTok: 1.1, cacheReadPerMTok: 0, cacheWritePerMTok: 0.2 },
  "glm-4.5": { inputPerMTok: 0.6, outputPerMTok: 2.2, cacheReadPerMTok: 0, cacheWritePerMTok: 0.6 },
};

export type EstimatedUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

// Returns null for an unpriced model — callers must show "unknown", never
// guess. Rounds to the nearest micro-dollar (integer millionths of a
// dollar); a SUM across many runs must not accumulate float error.
export function estimateCostMicroUsd(model: string, usage: EstimatedUsage): number | null {
  const price = MODEL_PRICING[model];
  if (!price) return null;
  const dollars =
    (usage.inputTokens / 1_000_000) * price.inputPerMTok +
    (usage.outputTokens / 1_000_000) * price.outputPerMTok +
    (usage.cacheReadTokens / 1_000_000) * price.cacheReadPerMTok +
    (usage.cacheWriteTokens / 1_000_000) * price.cacheWritePerMTok;
  return Math.round(dollars * 1_000_000);
}
