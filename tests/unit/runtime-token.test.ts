import { describe, expect, it } from "vitest";
import { signPreflightGatewayToken, verifyPreflightGatewayToken } from "@/lib/runtime-token";

describe("preflight gateway tokens", () => {
  it("binds a short-lived source operation to the preflight and repository", async () => {
    const claims = { preflightId: "preflight-1", sessionId: "session-1", repositoryId: "repo-1", candidateSha: "a".repeat(40), operation: "source" as const };
    const token = await signPreflightGatewayToken(claims, "runtime-secret");
    await expect(verifyPreflightGatewayToken(token, "runtime-secret")).resolves.toEqual(claims);
    await expect(verifyPreflightGatewayToken(token, "other-secret")).resolves.toBeNull();
  });
});
