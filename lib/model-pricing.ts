// Per-token list pricing for every model in PROVIDER_MODELS
// (lib/provider-credentials.ts). The only file in the codebase that contains
// per-token money — keep it that way so a price correction is a one-file
// change. Used only to ESTIMATE cost for providers that don't report a
// dollar figure themselves (lib/run-usage.ts); a genuine Anthropic run uses
// the SDK's own total_cost_usd instead (costSource: "reported") and never
// touches this table.
//
// PLACEHOLDER FIGURES: these model ids (claude-opus-5, gpt-5.6-terra, etc.)
// postdate this file's authoring; the prices below are estimates ordered by
// each vendor's own established tier ratios (haiku << sonnet < opus,
// flash-lite << flash < pro, etc.), NOT confirmed against a current price
// list. Verify against each vendor's published pricing before this feature
// ships to production, the same way lib/provider-credentials.ts:129-131
// flags the openai model id as unverified pending a spike.
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
  "claude-opus-5": { inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5, cacheWritePerMTok: 18.75 },
  "claude-fable-5": { inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5, cacheWritePerMTok: 18.75 },
  "claude-opus-4-8": { inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5, cacheWritePerMTok: 18.75 },
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
  "claude-haiku-4-5": { inputPerMTok: 0.8, outputPerMTok: 4, cacheReadPerMTok: 0.08, cacheWritePerMTok: 1 },

  // openai (via codex-runner.mjs — always estimated, Codex reports tokens only)
  "gpt-5.6-terra": { inputPerMTok: 5, outputPerMTok: 20, cacheReadPerMTok: 0.5, cacheWritePerMTok: 5 },

  // kimi (Moonshot; rides the Anthropic-Messages-compatible gateway, but
  // must never be priced with claude-opus-5-style "reported" cost — see
  // lib/run-usage.ts)
  "kimi-k3": { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2 },
  "kimi-k2.7-code": { inputPerMTok: 2.5, outputPerMTok: 12, cacheReadPerMTok: 0.25, cacheWritePerMTok: 2.5 },
  "kimi-k2.7-code-highspeed": { inputPerMTok: 3.5, outputPerMTok: 16, cacheReadPerMTok: 0.35, cacheWritePerMTok: 3.5 },
  "kimi-k2.6": { inputPerMTok: 1.5, outputPerMTok: 8, cacheReadPerMTok: 0.15, cacheWritePerMTok: 1.5 },

  // gemini
  "gemini-3.5-flash": { inputPerMTok: 0.5, outputPerMTok: 2.5, cacheReadPerMTok: 0.125, cacheWritePerMTok: 0.5 },
  "gemini-3.5-flash-lite": { inputPerMTok: 0.15, outputPerMTok: 0.6, cacheReadPerMTok: 0.0375, cacheWritePerMTok: 0.15 },
  "gemini-2.5-pro": { inputPerMTok: 2.5, outputPerMTok: 15, cacheReadPerMTok: 0.625, cacheWritePerMTok: 2.5 },
  "gemini-2.5-flash": { inputPerMTok: 0.3, outputPerMTok: 2.5, cacheReadPerMTok: 0.075, cacheWritePerMTok: 0.3 },
  "gemini-2.5-flash-lite": { inputPerMTok: 0.1, outputPerMTok: 0.4, cacheReadPerMTok: 0.025, cacheWritePerMTok: 0.1 },

  // glm (Z.ai; also rides the Anthropic-compat gateway — always estimated)
  "glm-5.3": { inputPerMTok: 2.5, outputPerMTok: 10, cacheReadPerMTok: 0.25, cacheWritePerMTok: 2.5 },
  "glm-5.2": { inputPerMTok: 2.5, outputPerMTok: 10, cacheReadPerMTok: 0.25, cacheWritePerMTok: 2.5 },
  "glm-5.1": { inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2 },
  "glm-5-turbo": { inputPerMTok: 1, outputPerMTok: 4, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1 },
  "glm-5": { inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2 },
  "glm-4.7": { inputPerMTok: 1.5, outputPerMTok: 6, cacheReadPerMTok: 0.15, cacheWritePerMTok: 1.5 },
  "glm-4.6": { inputPerMTok: 1.2, outputPerMTok: 5, cacheReadPerMTok: 0.12, cacheWritePerMTok: 1.2 },
  "glm-4.5-air": { inputPerMTok: 0.4, outputPerMTok: 1.6, cacheReadPerMTok: 0.04, cacheWritePerMTok: 0.4 },
  "glm-4.5": { inputPerMTok: 0.8, outputPerMTok: 3.2, cacheReadPerMTok: 0.08, cacheWritePerMTok: 0.8 },
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
