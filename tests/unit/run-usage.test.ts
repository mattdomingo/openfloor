import { describe, expect, it } from "vitest";
import { normalizeRunUsage } from "@/lib/run-usage";
import { estimateCostMicroUsd } from "@/lib/model-pricing";

describe("normalizeRunUsage", () => {
  // Real SDKResultSuccess.modelUsage shape (@anthropic-ai/claude-agent-sdk
  // 0.3.239's sdk.d.ts) — the SDK's own recommended token/cost field, summed
  // across every model the query() call touched.
  it("trusts the SDK's reported cost for a genuine anthropic run", () => {
    const result = normalizeRunUsage("anthropic", "claude-sonnet-5", {
      modelUsage: {
        "claude-sonnet-5": {
          inputTokens: 1000, outputTokens: 500,
          cacheReadInputTokens: 200, cacheCreationInputTokens: 50,
          costUSD: 0.0123,
        },
      },
      totalCostUsd: 0.0123,
    });
    expect(result).toEqual({
      inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 50,
      costMicroUsd: 12_300, costSource: "reported",
    });
  });

  // THE TRAP: kimi and glm ride the same claude-runner.mjs (Anthropic-
  // Messages-compatible), and the SDK happily reports a costUSD for that
  // traffic too — computed at ANTHROPIC's prices, not the vendor actually
  // billed. Must never be marked "reported".
  it("never trusts the SDK's cost for a kimi run through the same runner", () => {
    const result = normalizeRunUsage("kimi", "kimi-k3", {
      modelUsage: {
        "kimi-k3": {
          inputTokens: 1_000_000, outputTokens: 1_000_000,
          cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
          costUSD: 999, // what the SDK computed at Anthropic prices — must be ignored
        },
      },
      totalCostUsd: 999,
    });
    expect(result.costSource).toBe("estimated");
    expect(result.costMicroUsd).toBe(estimateCostMicroUsd("kimi-k3", {
      inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0,
    }));
    expect(result.costMicroUsd).not.toBe(999_000_000);
  });

  it("never trusts the SDK's cost for a glm run through the same runner", () => {
    const result = normalizeRunUsage("glm", "glm-5.3", {
      modelUsage: { "glm-5.3": { inputTokens: 100, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 5 } },
      totalCostUsd: 5,
    });
    expect(result.costSource).toBe("estimated");
  });

  it("returns empty usage for a run with no modelUsage at all (crash before any model call)", () => {
    expect(normalizeRunUsage("anthropic", "claude-sonnet-5", { modelUsage: null, totalCostUsd: null }))
      .toEqual({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costMicroUsd: null, costSource: null });
    expect(normalizeRunUsage("anthropic", "claude-sonnet-5", null))
      .toEqual({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costMicroUsd: null, costSource: null });
  });

  // Real @openai/codex-sdk Usage shape (dist/index.d.ts): cached_input_tokens
  // is a SUBSET of input_tokens (OpenAI Responses-API convention), so the
  // fresh-input count must subtract it, never double-count.
  it("normalizes Codex usage, treating cached_input_tokens as a subset of input_tokens", () => {
    const result = normalizeRunUsage("openai", "gpt-5.6-terra", {
      usage: {
        input_tokens: 1200, cached_input_tokens: 200, cache_write_input_tokens: 50,
        output_tokens: 300, reasoning_output_tokens: 100,
      },
    });
    expect(result.inputTokens).toBe(1000); // 1200 - 200
    expect(result.cacheReadTokens).toBe(200);
    expect(result.cacheWriteTokens).toBe(50);
    expect(result.outputTokens).toBe(300); // reasoning tokens already included, never added again
    expect(result.costSource).toBe("estimated");
    expect(result.costMicroUsd).toBe(estimateCostMicroUsd("gpt-5.6-terra", { inputTokens: 1000, outputTokens: 300, cacheReadTokens: 200, cacheWriteTokens: 50 }));
  });

  // Real gemini-cli stream-json `result.stats` shape
  // (StreamJsonFormatter.convertToStreamStats): `input` is already net of
  // `cached` — using the gross `input_tokens` here would double-count.
  it("normalizes Gemini stats, using the net-of-cache input field", () => {
    const result = normalizeRunUsage("gemini", "gemini-2.5-flash", {
      usage: { input: 800, cached: 200, output_tokens: 150, input_tokens: 1000, total_tokens: 1150 },
    });
    expect(result.inputTokens).toBe(800);
    expect(result.cacheReadTokens).toBe(200);
    expect(result.cacheWriteTokens).toBe(0);
    expect(result.outputTokens).toBe(150);
    expect(result.costSource).toBe("estimated");
  });

  it("returns null cost for an unpriced model, without guessing", () => {
    const result = normalizeRunUsage("openai", "some-future-model", {
      usage: { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 0 },
    });
    expect(result.costMicroUsd).toBeNull();
    expect(result.costSource).toBe("estimated");
  });
});
