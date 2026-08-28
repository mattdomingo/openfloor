import { describe, expect, it } from "vitest";
import { pickResumeSource, RESUME_MAX_AGE_MS, type ResumeCandidateRow } from "@/lib/run-resume";

const now = 1_800_000_000_000;

function row(overrides: Partial<ResumeCandidateRow> = {}): ResumeCandidateRow {
  return {
    id: "run-1",
    queueItemId: "item-1",
    attempt: 1,
    model: "gpt-5.6-terra",
    kind: null,
    providerThreadId: "thread-1",
    sessionStoreKey: "runs/run-1/session-store.tgz",
    completedAt: now - 60_000,
    createdAt: now - 120_000,
    ...overrides,
  };
}

const target = { queueItemId: "item-1", model: "gpt-5.6-terra", kind: null, now };

describe("pickResumeSource", () => {
  it("picks the newest same-item run that has both a thread id and a persisted store", () => {
    const newest = row({ id: "run-2", attempt: 2 });
    expect(pickResumeSource([newest, row()], target)?.id).toBe("run-2");
    // Newest-first input is the contract; a store-less newest row falls through to the next.
    expect(pickResumeSource([row({ id: "run-3", attempt: 3, sessionStoreKey: null }), newest], target)?.id).toBe("run-2");
  });

  it("only crosses queue items for an explicit source run", () => {
    const other = row({ id: "run-9", queueItemId: "item-9" });
    expect(pickResumeSource([other], target)).toBeNull();
    expect(pickResumeSource([other], { ...target, sourceRunId: "run-9" })?.id).toBe("run-9");
  });

  it("refuses a different model or run kind", () => {
    expect(pickResumeSource([row({ model: "claude-opus-5" })], target)).toBeNull();
    expect(pickResumeSource([row({ kind: "reply" })], target)).toBeNull();
    expect(pickResumeSource([row({ kind: "reply" })], { ...target, kind: "reply" })?.id).toBe("run-1");
  });

  it("refuses stale, thread-less, and store-less runs", () => {
    expect(pickResumeSource([row({ completedAt: now - RESUME_MAX_AGE_MS - 1 })], target)).toBeNull();
    expect(pickResumeSource([row({ completedAt: null, createdAt: now - RESUME_MAX_AGE_MS - 1 })], target)).toBeNull();
    expect(pickResumeSource([row({ completedAt: now - RESUME_MAX_AGE_MS + 1 })], target)?.id).toBe("run-1");
    expect(pickResumeSource([row({ providerThreadId: null })], target)).toBeNull();
    expect(pickResumeSource([row({ sessionStoreKey: null })], target)).toBeNull();
    expect(pickResumeSource([], target)).toBeNull();
  });
});
