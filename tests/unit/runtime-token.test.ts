import { describe, expect, it } from "vitest";
import { signPreflightGatewayToken, signRunGatewayToken, verifyPreflightGatewayToken, verifyRunGatewayToken } from "@/lib/runtime-token";

describe("preflight gateway tokens", () => {
  it("binds a short-lived source operation to the preflight and repository", async () => {
    const claims = { preflightId: "preflight-1", sessionId: "session-1", repositoryId: "repo-1", candidateSha: "a".repeat(40), operation: "source" as const };
    const token = await signPreflightGatewayToken(claims, "runtime-secret");
    await expect(verifyPreflightGatewayToken(token, "runtime-secret")).resolves.toEqual(claims);
    await expect(verifyPreflightGatewayToken(token, "other-secret")).resolves.toBeNull();
  });
});

describe("agent run gateway tokens", () => {
  it("binds source and OpenAI operations to one run", async () => {
    const claims = { runId: "run-1", sessionId: "session-1", repositoryId: "repo-1", candidateSha: "b".repeat(40), operation: "openai" as const };
    const token = await signRunGatewayToken(claims, "runtime-secret");
    await expect(verifyRunGatewayToken(token, "runtime-secret", "openai")).resolves.toEqual(claims);
    await expect(verifyRunGatewayToken(token, "runtime-secret", "source")).resolves.toBeNull();
    await expect(verifyRunGatewayToken(token, "wrong-secret", "openai")).resolves.toBeNull();
  });

  it("does not interchange bundle upload and trusted bundle read operations", async () => {
    const claims = { runId: "run-2", sessionId: "session-1", repositoryId: "repo-1", candidateSha: "c".repeat(40), operation: "bundle_upload" as const };
    const token = await signRunGatewayToken(claims, "runtime-secret");
    await expect(verifyRunGatewayToken(token, "runtime-secret", "bundle_upload")).resolves.toEqual(claims);
    await expect(verifyRunGatewayToken(token, "runtime-secret", "bundle_read")).resolves.toBeNull();
  });
});
