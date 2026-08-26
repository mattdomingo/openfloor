import { describe, expect, it } from "vitest";
import { queueItemDestination } from "@/components/session/data";
import type { AgentRun, FloorQueueItem } from "@/lib/floor-types";

function makeItem(overrides: Partial<FloorQueueItem> = {}): FloorQueueItem {
  return {
    id: "item-1",
    agentId: "agent-1",
    agentName: "Lumen",
    position: 1,
    status: "running",
    assignedBy: "user",
    assignedReason: null,
    intent: "task",
    rollback: null,
    prompts: [],
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

describe("queueItemDestination", () => {
  it("sends a live run to its agent", () => {
    const item = makeItem({ status: "running" });
    const run = makeRun({ status: "running" });
    expect(queueItemDestination(item, run)).toEqual({ kind: "agent", agentId: "agent-1" });
  });

  it("sends a mid-rollback run to its agent", () => {
    const item = makeItem({ status: "completed" });
    const run = makeRun({ status: "integrated", rollbackStatus: "running" });
    expect(queueItemDestination(item, run)).toEqual({ kind: "agent", agentId: "agent-1" });
  });

  it("sends an active integrated prompt to review", () => {
    const item = makeItem({ status: "completed", rollback: { runId: "run-1", status: null, failureReason: null, canStart: true } });
    const run = makeRun({ status: "integrated" });
    expect(queueItemDestination(item, run)).toEqual({ kind: "review", runId: "run-1", status: "active" });
  });

  it("sends a rolled-back prompt to review history", () => {
    const item = makeItem({ status: "completed", rollback: { runId: "run-1", status: "completed", failureReason: null, canStart: false } });
    const run = makeRun({ status: "integrated" });
    expect(queueItemDestination(item, run)).toEqual({ kind: "review", runId: "run-1", status: "rolled_back" });
  });

  it("falls back to the run itself when integrated but the snapshot has no rollback descriptor yet", () => {
    const item = makeItem({ status: "completed", rollback: null });
    const run = makeRun({ status: "integrated" });
    expect(queueItemDestination(item, run)).toEqual({ kind: "review", runId: "run-1", status: "active" });
  });

  it("opens inline detail for a failed run", () => {
    const item = makeItem({ status: "failed" });
    const run = makeRun({ status: "failed", summary: "Checks failed" });
    expect(queueItemDestination(item, run)).toEqual({ kind: "detail" });
  });

  it("opens inline detail for an answered reply run", () => {
    const item = makeItem({ status: "completed" });
    const run = makeRun({ status: "ready", kind: "reply", finalResponse: "Here is the answer." });
    expect(queueItemDestination(item, run)).toEqual({ kind: "detail" });
  });

  it("is not clickable for a queued item with no run", () => {
    const item = makeItem({ status: "queued" });
    expect(queueItemDestination(item, null)).toBeNull();
  });

  it("is not clickable for a paused item with no run and no assigned agent", () => {
    const item = makeItem({ status: "paused", agentId: null });
    expect(queueItemDestination(item, undefined)).toBeNull();
  });
});
