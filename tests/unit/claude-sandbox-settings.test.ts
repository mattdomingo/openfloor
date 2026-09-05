import { describe, expect, it } from "vitest";
import { buildClaudeSandboxSettings } from "@/lib/claude-sandbox-settings";

describe("Claude within mandatory outer namespace", () => {
  it("does not start a nested shell sandbox that hides the local broker", () => {
    expect(JSON.parse(buildClaudeSandboxSettings({ gatewayHost: "opnflr.com" }))).toEqual({ sandbox: { enabled: false } });
  });
});
