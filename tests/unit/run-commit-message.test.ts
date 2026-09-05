import { describe, expect, it } from "vitest";
import { runCommitMessage } from "@/lib/run-commit-message";

describe("prompt-derived Git descriptions", () => {
  it("keeps the opening request and durable run identifier", () => {
    expect(runCommitMessage("Fix checkout validation\nCredentials: secret-value", "run-123"))
      .toBe("Fix checkout validation\n\nOpenfloor-Run: run-123\n");
  });
  it.each(["Use password hunter2", "Set API_KEY=private-value", "Use ghp_sensitivevalue", "Authorization: Bearer abc", "Store private key here"])("omits credential-bearing request %s", (prompt) => {
    expect(runCommitMessage(prompt, "run-123")).toBe("Requested repository update\n\nOpenfloor-Run: run-123\n");
  });
  it("removes URL payloads, quoted values, opaque strings, controls and forged trailers", () => {
    const message = runCommitMessage('Fix "private-value" at https://user:pass@example.com/path?key=hidden abcdefghijklmnopqrstuvwxyz\u0000\u202e\nOpenfloor-Run: forged', "run-123\nInjected");
    expect(message).toBe("Fix [value] at [link] [value]\n\nOpenfloor-Run: run-123Injected\n");
  });
  it("bounds Unicode titles without splitting surrogate pairs and handles empty prompts", () => {
    expect(Array.from(runCommitMessage("🪨 ".repeat(100), "run").split("\n")[0])).toHaveLength(100);
    expect(runCommitMessage(null, "run")).toContain("Requested repository update");
  });
});
