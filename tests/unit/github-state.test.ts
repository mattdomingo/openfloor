import { describe, expect, it } from "vitest";
import {
  signGitHubStateId,
  verifyGitHubStateToken,
  verifyGitHubWebhookSignature,
} from "@/lib/github-state";

describe("GitHub signed boundaries", () => {
  it("signs state IDs and rejects tampering or another secret", async () => {
    const token = await signGitHubStateId("state-id", "state-secret");
    await expect(verifyGitHubStateToken(token, "state-secret")).resolves.toBe("state-id");
    await expect(verifyGitHubStateToken(`${token}x`, "state-secret")).resolves.toBeNull();
    await expect(verifyGitHubStateToken(token, "other-secret")).resolves.toBeNull();
  });

  it("verifies the exact webhook bytes", async () => {
    const payload = new TextEncoder().encode('{"zen":"hello"}');
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("webhook-secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, payload));
    const signature = `sha256=${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    await expect(verifyGitHubWebhookSignature(payload.buffer, signature, "webhook-secret")).resolves.toBe(true);
    await expect(verifyGitHubWebhookSignature(new TextEncoder().encode("changed").buffer, signature, "webhook-secret")).resolves.toBe(false);
  });
});
