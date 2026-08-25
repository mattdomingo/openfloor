import { describe, expect, it } from "vitest";
import { claimConflictAlert, conflictAttentionEvent } from "@/lib/conflict-notifications";
import type { MergeConflictCase } from "@/lib/floor-types";

function conflict(status: MergeConflictCase["status"]): MergeConflictCase {
  return {
    id: "case-1", status, sourceRunId: "run-1", latestSourceRunId: "run-1", currentResolverRunId: null,
    queueItemId: "queue-1", agentId: "agent-1", agentName: "Lumen", conflictReason: "conflict", explanation: null,
    conflictPaths: ["a.ts"], automaticAttempts: 0, failureReason: null, questions: [], prompts: [], attempts: [], createdAt: 1, updatedAt: 2, resolvedAt: null,
  };
}

describe("conflict browser alerts", () => {
  it("selects only attention states and changes receipt when event changes", () => {
    expect(conflictAttentionEvent(conflict("awaiting_input"))).toBe("case-1:awaiting_input:2");
    expect(conflictAttentionEvent(conflict("failed"))).toBe("case-1:failed:2");
    expect(conflictAttentionEvent(conflict("pending"))).toBeNull();
    expect(conflictAttentionEvent(conflict("resolved"))).toBeNull();
  });

  it("claims one alert receipt during its TTL", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    expect(claimConflictAlert(storage, "event", 1_000)).toBe(true);
    expect(claimConflictAlert(storage, "event", 2_000)).toBe(false);
    expect(claimConflictAlert(storage, "other", 2_000)).toBe(true);
  });
});
