import { describe, expect, it } from "vitest";
import { formatAgentCost } from "@/components/session/data";

describe("formatAgentCost", () => {
  it("shows a dash for an agent with no priced runs yet", () => {
    expect(formatAgentCost({ costMicroUsd: null, costSource: null, billedKind: null }).label).toBe("—");
  });

  it("shows a plain dollar figure for a reported (genuine anthropic) cost", () => {
    const result = formatAgentCost({ costMicroUsd: 1_230_000, costSource: "reported", billedKind: "api_key" });
    expect(result.label).toBe("$1.23");
  });

  it("prefixes an estimated cost with a tilde", () => {
    const result = formatAgentCost({ costMicroUsd: 1_230_000, costSource: "estimated", billedKind: "api_key" });
    expect(result.label).toBe("~$1.23");
  });

  it("prefixes a mixed-history cost with a tilde too (it is no longer purely reported)", () => {
    const result = formatAgentCost({ costMicroUsd: 1_230_000, costSource: "mixed", billedKind: "api_key" });
    expect(result.label).toBe("~$1.23");
  });

  it("appends the subscription note only for an oauth-billed agent", () => {
    const oauth = formatAgentCost({ costMicroUsd: 500_000, costSource: "reported", billedKind: "oauth" });
    expect(oauth.label).toBe("$0.50 · incl. in subscription");
    const apiKey = formatAgentCost({ costMicroUsd: 500_000, costSource: "reported", billedKind: "api_key" });
    expect(apiKey.label).toBe("$0.50");
  });
});
