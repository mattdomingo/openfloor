import { describe, expect, it } from "vitest";
import { groupQueueItems, QUEUE_GROUP_LABELS, QUEUE_GROUP_ORDER, queueItemGroup } from "@/components/session/data";
import type { AgentRun, FloorQueueItem, FloorQueuePrompt } from "@/lib/floor-types";

function makePrompt(overrides: Partial<FloorQueuePrompt> = {}): FloorQueuePrompt {
  return {
    id: "prompt-1",
    authorUserId: "user-1",
    authorName: "Ada",
    text: "Do the thing",
    createdAt: 0,
    ...overrides,
  };
}

function makeItem(overrides: Partial<FloorQueueItem> = {}): FloorQueueItem {
  return {
    id: "item-1",
    agentId: "agent-1",
    agentName: "Lumen",
    position: 1,
    status: "running",
    assignedBy: "user",
    assignedReason: null,
    origin: null,
    intent: "task",
    rollback: null,
    answer: null,
    prompts: [makePrompt()],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "run-1",
    queueItemId: "item-1",
    agentId: "agent-1",
    agentName: "Lumen",
    candidateId: "candidate-1",
    candidateSha: "sha",
    runBranch: null,
    localCommitSha: null,
    runCommitSha: null,
    remoteRunSha: null,
    attempt: 1,
    status: "running",
    kind: null,
    model: "model",
    summary: null,
    finalResponse: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    resumedFromRunId: null,
    resumedFromAttempt: null,
    providerThreadResumed: null,
    createdBy: "user-1",
    createdAt: 0,
    startedAt: null,
    completedAt: null,
    publishedAt: null,
    integrationBaseSha: null,
    integratedCandidateSha: null,
    conflictReason: null,
    integrationStartedAt: null,
    integratedAt: null,
    discardedAt: null,
    branchDeletedAt: null,
    cancelRequestedAt: null,
    updatedAt: 0,
    purpose: "task",
    conflictCaseId: null,
    rollbackId: null,
    rollbackStatus: null,
    rollbackExpectedCandidateSha: null,
    rollbackCommitSha: null,
    rollbackFailureReason: null,
    rollbackBy: null,
    rollbackRequestedAt: null,
    rollbackCompletedAt: null,
    checks: [],
    files: [],
    ...overrides,
  };
}

describe("queueItemGroup", () => {
  it("keeps queued and paused items live even with no run", () => {
    expect(queueItemGroup(makeItem({ status: "queued" }), undefined)).toBe("live");
    expect(queueItemGroup(makeItem({ status: "paused" }), null)).toBe("live");
  });

  it("lets a resumed queued item win over its stale failed run", () => {
    const item = makeItem({ status: "queued" });
    const run = makeRun({ status: "failed" });
    expect(queueItemGroup(item, run)).toBe("live");
  });

  it.each(["provisioning", "running", "checking", "publishing", "integrating", "cancel_requested"] as const)(
    "keeps an active %s run live",
    (status) => {
      expect(queueItemGroup(makeItem({ status: "running" }), makeRun({ status }))).toBe("live");
    },
  );

  it("keeps parked ready and published task runs live", () => {
    expect(queueItemGroup(makeItem({ status: "blocked" }), makeRun({ status: "ready" }))).toBe("live");
    expect(queueItemGroup(makeItem({ status: "blocked" }), makeRun({ status: "published" }))).toBe("live");
  });

  it("keeps a discarded published run live, matching its pre-grouping position", () => {
    const run = makeRun({ status: "published", discardedAt: 1 });
    expect(queueItemGroup(makeItem({ status: "blocked" }), run)).toBe("live");
  });

  it("keeps a mid-rollback item live", () => {
    const item = makeItem({ status: "completed", rollback: { runId: "run-1", status: "running", failureReason: null, canStart: false } });
    expect(queueItemGroup(item, makeRun({ status: "integrated", rollbackStatus: "running" }))).toBe("live");
  });

  it("gives a conflicted run its own section", () => {
    const run = makeRun({ status: "conflicted", conflictReason: "merge conflict" });
    expect(queueItemGroup(makeItem({ status: "failed" }), run)).toBe("conflicted");
  });

  it("puts failed runs, failed items, and failed rollbacks in failed", () => {
    expect(queueItemGroup(makeItem({ status: "failed" }), makeRun({ status: "failed" }))).toBe("failed");
    expect(queueItemGroup(makeItem({ status: "failed" }), undefined)).toBe("failed");
    const rollbackFailed = makeItem({ status: "completed", rollback: { runId: "run-1", status: "failed", failureReason: "push rejected", canStart: true } });
    expect(queueItemGroup(rollbackFailed, makeRun({ status: "integrated", rollbackStatus: "failed" }))).toBe("failed");
  });

  it("puts an answered reply run in answered, including after the run ages out", () => {
    const run = makeRun({ status: "ready", kind: "reply", finalResponse: "Here is the answer." });
    expect(queueItemGroup(makeItem({ status: "completed" }), run)).toBe("answered");
    const agedOut = makeItem({ status: "completed", answer: { runId: "run-old", agentId: "agent-2", agentName: "Concierge", text: "Here is the answer.", createdAt: 0 } });
    expect(queueItemGroup(agedOut, undefined)).toBe("answered");
  });

  it("puts integrated, rolled-back, and rollback-descriptor items in integrated", () => {
    expect(queueItemGroup(makeItem({ status: "completed" }), makeRun({ status: "integrated" }))).toBe("integrated");
    const rolledBack = makeItem({ status: "completed", rollback: { runId: "run-1", status: "completed", failureReason: null, canStart: false } });
    expect(queueItemGroup(rolledBack, makeRun({ status: "integrated", rollbackStatus: "completed" }))).toBe("integrated");
    const agedOut = makeItem({ status: "completed", rollback: { runId: "run-old", status: null, failureReason: null, canStart: true } });
    expect(queueItemGroup(agedOut, undefined)).toBe("integrated");
    expect(queueItemGroup(makeItem({ status: "completed" }), undefined)).toBe("completed");
    expect(queueItemGroup(makeItem({ status: "completed" }), makeRun({ status: "ready", completion: "no_changes" }))).toBe("completed");
  });

  it("puts cancelled runs and items in cancelled", () => {
    expect(queueItemGroup(makeItem({ status: "cancelled" }), makeRun({ status: "cancelled" }))).toBe("cancelled");
    expect(queueItemGroup(makeItem({ status: "cancelled" }), undefined)).toBe("cancelled");
  });
});

describe("groupQueueItems", () => {
  it("returns every section in fixed order with labels", () => {
    const groups = groupQueueItems([], new Map(), "team", "user-1");
    expect(groups.map((group) => group.id)).toEqual([...QUEUE_GROUP_ORDER]);
    expect(groups.map((group) => group.label)).toEqual(QUEUE_GROUP_ORDER.map((id) => QUEUE_GROUP_LABELS[id]));
  });

  it("orders live items by position ascending, not recency", () => {
    const older = makeItem({ id: "a", position: 2, status: "queued", createdAt: 100 });
    const newer = makeItem({ id: "b", position: 1, status: "queued", createdAt: 200 });
    const groups = groupQueueItems([older, newer], new Map(), "team", "user-1");
    expect(groups[0].id).toBe("live");
    expect(groups[0].items.map((item) => item.id)).toEqual(["b", "a"]);
  });

  it("orders finished sections newest-first", () => {
    const older = makeItem({ id: "a", status: "cancelled", createdAt: 100 });
    const newer = makeItem({ id: "b", status: "cancelled", createdAt: 200 });
    const groups = groupQueueItems([older, newer], new Map(), "team", "user-1");
    const cancelled = groups.find((group) => group.id === "cancelled")!;
    expect(cancelled.items.map((item) => item.id)).toEqual(["b", "a"]);
  });

  it("keeps finished items out of live and live items out of finished sections", () => {
    const queued = makeItem({ id: "q", position: 1, status: "queued" });
    const integrated = makeItem({ id: "i", status: "completed", createdAt: 50 });
    const runs = new Map([["i", makeRun({ queueItemId: "i", status: "integrated" })]]);
    const groups = groupQueueItems([queued, integrated], runs, "team", "user-1");
    expect(groups.find((group) => group.id === "live")!.items.map((item) => item.id)).toEqual(["q"]);
    expect(groups.find((group) => group.id === "integrated")!.items.map((item) => item.id)).toEqual(["i"]);
  });

  it("filters to items the current user authored in mine scope", () => {
    const mine = makeItem({ id: "mine", status: "queued", prompts: [makePrompt({ authorUserId: "user-1" })] });
    const theirs = makeItem({ id: "theirs", status: "queued", position: 2, prompts: [makePrompt({ id: "prompt-2", authorUserId: "user-2", authorName: "Grace" })] });
    const groups = groupQueueItems([mine, theirs], new Map(), "mine", "user-1");
    expect(groups.find((group) => group.id === "live")!.items.map((item) => item.id)).toEqual(["mine"]);
  });
});
