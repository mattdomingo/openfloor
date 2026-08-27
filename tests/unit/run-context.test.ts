import { describe, expect, it } from "vitest";
import { runContextUsage } from "@/components/session/data";
import { MODEL_CONTEXT_TOKENS, PROVIDER_MODELS } from "@/lib/provider-credentials";

const NO_USAGE = { model: "claude-sonnet-5", inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null };

describe("runContextUsage", () => {
  it("returns null when the run recorded no prompt-side tokens", () => {
    expect(runContextUsage(NO_USAGE, 1_000_000)).toBeNull();
  });

  it("sums prompt-side tokens and levels against the window", () => {
    const usage = runContextUsage(
      { model: "claude-sonnet-5", inputTokens: 100_000, outputTokens: 5_000, cacheReadTokens: 700_000, cacheWriteTokens: 50_000 },
      1_000_000,
    );
    expect(usage).toMatchObject({ promptTokens: 850_000, windowTokens: 1_000_000, level: "warn" });
    expect(usage?.label).toBe("850K of 1M window · 5K out");
  });

  it("shows a plain count with no meter for an undocumented window", () => {
    const usage = runContextUsage({ ...NO_USAGE, inputTokens: 1_234 }, null);
    expect(usage).toMatchObject({ windowTokens: null, level: "ok", label: "1K prompt tokens" });
  });

  it("caps at over when the cumulative total passes the window", () => {
    const usage = runContextUsage({ ...NO_USAGE, inputTokens: 1_200_000 }, 1_000_000);
    expect(usage?.level).toBe("over");
  });
});

describe("MODEL_CONTEXT_TOKENS", () => {
  it("only names models PROVIDER_MODELS actually offers", () => {
    const offered = new Set(Object.values(PROVIDER_MODELS).flat());
    for (const model of Object.keys(MODEL_CONTEXT_TOKENS)) expect(offered).toContain(model);
  });
});
