import { describe, expect, it } from "vitest";
import { rollbackSandboxIds } from "@/lib/rollback-sandbox";

describe("rollback Sandbox identifiers", () => {
  it("stays within Cloudflare's 63-character limit for grouped and legacy rollbacks", () => {
    const rollbackId = "e8e423c3-10d3-45d0-a320-55f4c7de5cda";
    const instanceId = `rollback-group-${rollbackId}`;

    expect(`rollback-publisher-${instanceId}`).toHaveLength(70);
    expect(rollbackSandboxIds(rollbackId)).toEqual({
      executor: `rollback-${rollbackId}`,
      publisher: `rollback-publisher-${rollbackId}`,
    });
    expect(Object.values(rollbackSandboxIds(rollbackId)).every((id) => id.length <= 63)).toBe(true);
  });

  it("rejects identifiers outside the durable rollback UUID contract", () => {
    expect(() => rollbackSandboxIds("rollback-group-too-long")).toThrow("Rollback identifier is invalid");
  });
});
