// Normalizes each provider's raw usage blob (captured by the runner scripts
// into result.json, read by worker/agent-run-workflow.ts) into one shape for
// db/runs.ts to persist. Pure and side-effect-free so it is unit-testable
// against real captured fixtures without a sandbox.
import { estimateCostMicroUsd } from "./model-pricing";
import { usesQwenRunner, type CredentialProvider } from "./provider-credentials";

export type NormalizedRunUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costMicroUsd: number | null;
  costSource: "reported" | "estimated" | null;
};

const EMPTY: NormalizedRunUsage = {
  inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
  costMicroUsd: null, costSource: null,
};

// Claude Agent SDK's ModelUsage (one entry per model the query() call
// touched — main loop, Task subagents, sidechains, internal calls). Anthropic
// Messages API convention: inputTokens/outputTokens are fresh-only, cache
// reads/writes are separate counters, never included in inputTokens.
type ClaudeModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
};

// @openai/codex-sdk's Usage (one per turn.completed event). cached_input_tokens
// and cache_write_input_tokens are OpenAI Responses-API-style breakdowns: the
// cached count is a SUBSET of input_tokens, the write count is additional.
// reasoning_output_tokens is already included in output_tokens (OpenAI bills
// reasoning as output), never added separately.
type CodexUsage = {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
};

// gemini-cli's stream-json `result` event stats (StreamJsonFormatter.
// convertToStreamStats). `input` is already net-of-cache (Math.max(0, prompt
// - cached)); `input_tokens` is the gross prompt count and is NOT used here,
// to avoid double-counting the cached portion. No cache-write breakdown
// exists — Gemini's CLI does not report one.
type GeminiStats = {
  input: number;
  cached: number;
  output_tokens: number;
};

// Qwen Code's stream-json `result.usage` (Spike Q1, 2026-08-28): the CLI sums
// each chat-completions call's OpenAI `prompt_tokens` into `input_tokens`
// (GROSS — the cached portion is included) and `prompt_tokens_details.
// cached_tokens` into `cache_read_input_tokens`, so the net input is the
// difference. No cache-write counter exists on the chat-completions wire.
type QwenUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  total_tokens?: number;
};

// A kimi/glm run rides the same Claude Agent SDK runner as anthropic
// (usesClaudeRunner in lib/provider-credentials.ts), because those vendors'
// APIs are Anthropic-Messages-compatible. The SDK still happily reports a
// modelUsage costUSD for that traffic — computed at ANTHROPIC's prices, not
// the vendor actually billed. Only a genuine anthropic run may be
// "reported"; kimi/glm must always be priced from MODEL_PRICING, marked
// "estimated", even though their usage arrived through the same SDK.
export function normalizeRunUsage(
  provider: CredentialProvider,
  model: string,
  raw: {
    usage?: unknown;
    modelUsage?: Record<string, ClaudeModelUsage> | null;
    totalCostUsd?: number | null;
  } | null,
): NormalizedRunUsage {
  if (!raw) return EMPTY;
  if (provider === "anthropic" || provider === "kimi" || provider === "glm") {
    return normalizeClaudeRunnerUsage(provider, raw.modelUsage ?? null);
  }
  if (provider === "openai") {
    return normalizeCodexUsage(model, raw.usage as CodexUsage | null | undefined);
  }
  if (provider === "gemini") {
    return normalizeGeminiUsage(model, raw.usage as GeminiStats | null | undefined);
  }
  if (usesQwenRunner(provider)) {
    return normalizeQwenUsage(model, raw.usage as QwenUsage | null | undefined);
  }
  return EMPTY;
}

function normalizeClaudeRunnerUsage(
  provider: CredentialProvider,
  modelUsage: Record<string, ClaudeModelUsage> | null,
): NormalizedRunUsage {
  const entries = modelUsage ? Object.values(modelUsage) : [];
  if (entries.length === 0) return EMPTY;
  const totals = entries.reduce((acc, entry) => ({
    inputTokens: acc.inputTokens + (entry.inputTokens ?? 0),
    outputTokens: acc.outputTokens + (entry.outputTokens ?? 0),
    cacheReadTokens: acc.cacheReadTokens + (entry.cacheReadInputTokens ?? 0),
    cacheWriteTokens: acc.cacheWriteTokens + (entry.cacheCreationInputTokens ?? 0),
    costUsd: acc.costUsd + (entry.costUSD ?? 0),
  }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 });
  if (provider === "anthropic") {
    return {
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
      costMicroUsd: Math.round(totals.costUsd * 1_000_000),
      costSource: "reported",
    };
  }
  // kimi/glm: never trust the SDK's Anthropic-priced costUSD — reprice from
  // token counts against the vendor's own MODEL_PRICING entry.
  const primaryModel = Object.keys(modelUsage ?? {})[0] ?? "";
  const costMicroUsd = estimateCostMicroUsd(primaryModel, {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
  });
  return {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    costMicroUsd,
    costSource: "estimated",
  };
}

function normalizeCodexUsage(model: string, usage: CodexUsage | null | undefined): NormalizedRunUsage {
  if (!usage) return EMPTY;
  const cacheReadTokens = usage.cached_input_tokens ?? 0;
  const inputTokens = Math.max(0, (usage.input_tokens ?? 0) - cacheReadTokens);
  const cacheWriteTokens = usage.cache_write_input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const costMicroUsd = estimateCostMicroUsd(model, { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costMicroUsd, costSource: "estimated" };
}

function normalizeQwenUsage(model: string, usage: QwenUsage | null | undefined): NormalizedRunUsage {
  if (!usage) return EMPTY;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const inputTokens = Math.max(0, (usage.input_tokens ?? 0) - cacheReadTokens);
  const outputTokens = usage.output_tokens ?? 0;
  const costMicroUsd = estimateCostMicroUsd(model, { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: 0 });
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: 0, costMicroUsd, costSource: "estimated" };
}

function normalizeGeminiUsage(model: string, stats: GeminiStats | null | undefined): NormalizedRunUsage {
  if (!stats) return EMPTY;
  const inputTokens = stats.input ?? 0;
  const cacheReadTokens = stats.cached ?? 0;
  const outputTokens = stats.output_tokens ?? 0;
  const costMicroUsd = estimateCostMicroUsd(model, { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: 0 });
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: 0, costMicroUsd, costSource: "estimated" };
}
