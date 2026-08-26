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
      // A thrown server error (e.g. an unhandled DB constraint) renders as a
      // non-JSON error page, not a MutationResult. Reading text first and
      // parsing it ourselves means that case reports its real HTTP status
      // instead of falling into the catch block below and being misreported
      // as "The floor could not be reached" — a network-failure message for
      // what was actually a reachable server returning an error.
      const text = await response.text();
      let result: MutationResult | null = null;
      try {
        result = text ? (JSON.parse(text) as MutationResult) : null;
      } catch {
        result = null;
      }
      if (!response.ok || !result?.floor) {
        setError(result?.error ?? `The floor returned an unexpected error (${response.status}).`);
        setBlockingRunId(result?.runId ?? null);
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
    updateAgentSettings: (agentId: string, patch: import("@/lib/floor-types").FloorAgentSettingsPatch) =>
      request(`/agents/${encodeURIComponent(agentId)}`, "PATCH", patch),
    pauseAgent: (agentId: string, paused: boolean) => request(`/agents/${encodeURIComponent(agentId)}/pause`, "PATCH", { paused }),
    stopAgent: (agentId: string) => request(`/agents/${encodeURIComponent(agentId)}/stop`, "POST"),
    deleteAgent: (agentId: string) => request(`/agents/${encodeURIComponent(agentId)}`, "DELETE"),
    pauseAllAgents: () => request("/agents/pause-all", "POST"),
    resumeAllAgents: () => request("/agents/resume-all", "POST"),
    stopAllAgents: () => request("/agents/stop-all", "POST"),
    updateAssignment: (memberId: string, task: string | null) => request(`/assignments/${encodeURIComponent(memberId)}`, "PATCH", { task }),
    sendMessage: (text: string, recipientUserId: string | null) => request("/messages", "POST", { text, recipientUserId }),
    addQueueItem: (prompt: string, agentId: string | null) => request("/queue", "POST", { prompt, agentId }),
    reorderQueue: (itemIds: string[]) => request("/queue/order", "PATCH", { itemIds }),
    setQueueItemAgent: (queueItemId: string, agentId: string) =>
      request(`/queue/${encodeURIComponent(queueItemId)}`, "PATCH", { agentId }),
    runQueueItem: (queueItemId: string) => request(`/queue/${encodeURIComponent(queueItemId)}/run`, "POST"),
    editQueuePrompt: (queueItemId: string, promptId: string, text: string) =>
      request(`/queue/${encodeURIComponent(queueItemId)}/prompts/${encodeURIComponent(promptId)}`, "PATCH", { text }),
    setQueueItemPaused: (queueItemId: string, paused: boolean) =>
      request(`/queue/${encodeURIComponent(queueItemId)}/pause`, "PATCH", { paused }),
    deleteQueueItem: (queueItemId: string) => request(`/queue/${encodeURIComponent(queueItemId)}`, "DELETE"),
    setAutoDispatch: (autoDispatch: boolean) => request("/routing", "PATCH", { autoDispatch }),
    setAutoProvisionAgents: (autoProvisionAgents: boolean) => request("/routing", "PATCH", { autoProvisionAgents }),
    setAutoAgentProvider: (autoAgentProvider: import("@/lib/provider-credentials").CredentialProvider | null) => request("/routing", "PATCH", { autoAgentProvider }),
    setAutoResolveConflicts: (autoResolveConflicts: boolean) => request("/routing", "PATCH", { autoResolveConflicts }),
    resolveConflict: (caseId: string) => request(`/conflicts/${encodeURIComponent(caseId)}/resolve`, "POST"),
    answerConflict: (caseId: string, answers: Array<{ questionId: string; answer: string }>) =>
      request(`/conflicts/${encodeURIComponent(caseId)}/answers`, "POST", { answers }),
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
