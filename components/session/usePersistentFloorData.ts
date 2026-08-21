"use client";

import { useCallback, useState } from "react";
import { BASE_PATH } from "@/components/basePath";
import type { CreateFloorAgentInput, FloorParticipant, FloorSnapshot } from "@/lib/floor-types";
import type { AppUser, SessionMember } from "@/lib/session-types";
import { initials } from "./data";

type MutationResult = { floor?: FloorSnapshot; error?: string; runId?: string };

export function usePersistentFloorData(sessionId: string, initialFloor: FloorSnapshot, onMissing: () => void) {
  const [floor, setFloor] = useState(initialFloor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockingRunId, setBlockingRunId] = useState<string | null>(null);

  const request = useCallback(async (path: string, method: string, body?: unknown) => {
    setBusy(true);
    setError(null);
    setBlockingRunId(null);
    try {
      const response = await fetch(`${BASE_PATH}/api/sessions/${sessionId}${path}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
      });
      if (response.status === 404) {
        onMissing();
        return null;
      }
      const result = (await response.json()) as MutationResult;
      if (!response.ok || !result.floor) {
        setError(result.error ?? "The floor could not be updated.");
        setBlockingRunId(result.runId ?? null);
        return null;
      }
      setFloor(result.floor);
      return result.floor;
    } catch {
      setError("The floor could not be reached.");
      return null;
    } finally {
      setBusy(false);
    }
  }, [onMissing, sessionId]);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${BASE_PATH}/api/sessions/${sessionId}/floor`, { cache: "no-store" });
      if (response.status === 404) {
        onMissing();
        return;
      }
      if (!response.ok) return;
      const result = (await response.json()) as { floor: FloorSnapshot };
      setFloor((current) => result.floor.revision >= current.revision ? result.floor : current);
    } catch {
      // WebSocket reconnects and later floor events provide another refresh opportunity.
    }
  }, [onMissing, sessionId]);

  return {
    kind: "persistent" as const,
    floor,
    busy,
    error,
    blockingRunId,
    setError,
    clearError: () => setError(null),
    refresh,
    createAgent: (input: CreateFloorAgentInput) => request("/agents", "POST", input),
    updateAgentTask: (agentId: string, task: string) => request(`/agents/${encodeURIComponent(agentId)}`, "PATCH", { task }),
    updateAssignment: (memberId: string, task: string | null) => request(`/assignments/${encodeURIComponent(memberId)}`, "PATCH", { task }),
    sendMessage: (text: string, recipientUserId: string | null) => request("/messages", "POST", { text, recipientUserId }),
    addQueueItem: (prompt: string, agentId: string | null) => request("/queue", "POST", { prompt, agentId }),
    reorderQueue: (itemIds: string[]) => request("/queue/order", "PATCH", { itemIds }),
    mergeQueue: (itemIds: string[]) => request("/queue/merge", "POST", { itemIds }),
    runQueueItem: (queueItemId: string) => request(`/queue/${encodeURIComponent(queueItemId)}/run`, "POST"),
    editQueuePrompt: (queueItemId: string, promptId: string, text: string) =>
      request(`/queue/${encodeURIComponent(queueItemId)}/prompts/${encodeURIComponent(promptId)}`, "PATCH", { text }),
    setQueueItemPaused: (queueItemId: string, paused: boolean) =>
      request(`/queue/${encodeURIComponent(queueItemId)}/pause`, "PATCH", { paused }),
    deleteQueueItem: (queueItemId: string) => request(`/queue/${encodeURIComponent(queueItemId)}`, "DELETE"),
    setAutoDispatch: (autoDispatch: boolean) => request("/routing", "PATCH", { autoDispatch }),
    cancelRun: (runId: string) => request(`/runs/${encodeURIComponent(runId)}/cancel`, "POST"),
    discardRun: (runId: string) => request(`/runs/${encodeURIComponent(runId)}/discard`, "POST"),
    retryRun: (runId: string) => request(`/runs/${encodeURIComponent(runId)}/retry`, "POST"),
    readyReview: () => request("/review/ready", "POST"),
    squashMergeReview: (deleteCandidateBranch: boolean) => request("/review/merge", "POST", { deleteCandidateBranch }),
    deleteReviewBranch: () => request("/review/branch", "DELETE"),
  };
}

export type PersistentFloorDataSource = ReturnType<typeof usePersistentFloorData>;

export function floorParticipants(members: SessionMember[], user: AppUser): FloorParticipant[] {
  return members.map((member, index) => ({
    id: member.id,
    name: member.displayName,
    initials: initials(member.displayName),
    tone: member.id === user.id ? "you" : `member-${index}`,
    role: member.role,
    online: member.online,
    isCurrentUser: member.id === user.id,
  }));
}
