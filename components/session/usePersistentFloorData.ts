"use client";

import { useCallback, useMemo, useState } from "react";
import { BASE_PATH } from "@/components/basePath";
import type { AgentRunRollbackScope, CreateFloorAgentInput, FloorParticipant, FloorSnapshot } from "@/lib/floor-types";
import { sessionUploadErrorMessage, validateSessionFileUploads } from "@/lib/session-file-constraints";
import type { AppUser, SessionMember } from "@/lib/session-types";
import { initials } from "./data";

type MutationResult = { floor?: FloorSnapshot; error?: string; runId?: string };

export function usePersistentFloorData(sessionId: string, initialFloor: FloorSnapshot, onMissing: () => void) {
  const [floor, setFloor] = useState(initialFloor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockingRunId, setBlockingRunId] = useState<string | null>(null);

  const request = useCallback(async (path: string, method: string, body?: unknown, reportError?: (message: string) => void) => {
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
      if (response.status === 404 && !path.startsWith("/conflicts/")) {
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
        const message = result?.error ?? `The floor returned an unexpected error (${response.status}).`;
        if (reportError) reportError(message); else setError(message);
        setBlockingRunId(result?.runId ?? null);
        return null;
      }
      setFloor((current) => result.floor!.revision >= current.revision ? result.floor! : current);
      return result.floor;
    } catch {
      if (reportError) reportError("The floor could not be reached. Retry when connected."); else setError("The floor could not be reached.");
      return null;
    } finally {
      setBusy(false);
    }
  }, [onMissing, sessionId]);

  // Multipart sibling of `request` (ENG-113): uploads files, adopts the
  // returned floor, and hands back the new file ids so the chat composer can
  // link them to the message it sends next.
  const uploadFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return [] as string[];
    const validationError = validateSessionFileUploads(files);
    if (validationError) {
      setError(validationError);
      return null;
    }
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      for (const file of files) form.append("files", file);
      const response = await fetch(`${BASE_PATH}/api/sessions/${sessionId}/files`, { method: "POST", body: form, cache: "no-store" });
      if (response.status === 404) {
        onMissing();
        return null;
      }
      const text = await response.text();
      let result: (MutationResult & { fileIds?: string[] }) | null = null;
      try {
        result = text ? (JSON.parse(text) as MutationResult & { fileIds?: string[] }) : null;
      } catch {
        result = null;
      }
      if (!response.ok || !result?.floor || !result.fileIds) {
        setError(sessionUploadErrorMessage(response.status, result?.error));
        return null;
      }
      setFloor(result.floor);
      return result.fileIds;
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

  const clearError = useCallback(() => setError(null), []);
  const createAgent = useCallback((input: CreateFloorAgentInput) => request("/agents", "POST", input), [request]);
  const updateAgentSettings = useCallback((agentId: string, patch: import("@/lib/floor-types").FloorAgentSettingsPatch) =>
    request(`/agents/${encodeURIComponent(agentId)}`, "PATCH", patch), [request]);
  const pauseAgent = useCallback((agentId: string, paused: boolean) =>
    request(`/agents/${encodeURIComponent(agentId)}/pause`, "PATCH", { paused }), [request]);
  const stopAgent = useCallback((agentId: string) =>
    request(`/agents/${encodeURIComponent(agentId)}/stop`, "POST"), [request]);
  const deleteAgent = useCallback((agentId: string) =>
    request(`/agents/${encodeURIComponent(agentId)}`, "DELETE"), [request]);
  const pauseAllAgents = useCallback(() => request("/agents/pause-all", "POST"), [request]);
  const resumeAllAgents = useCallback(() => request("/agents/resume-all", "POST"), [request]);
  const stopAllAgents = useCallback(() => request("/agents/stop-all", "POST"), [request]);
  const updateAssignment = useCallback((memberId: string, task: string | null) =>
    request(`/assignments/${encodeURIComponent(memberId)}`, "PATCH", { task }), [request]);
  const sendMessage = useCallback((text: string, recipientUserId: string | null, attachmentIds?: string[]) =>
    request("/messages", "POST", { text, recipientUserId, ...(attachmentIds?.length ? { attachmentIds } : {}) }), [request]);
  const addQueueItem = useCallback((prompt: string, agentId: string | null) =>
    request("/queue", "POST", { prompt, agentId }), [request]);
  const reorderQueue = useCallback((itemIds: string[]) =>
    request("/queue/order", "PATCH", { itemIds }), [request]);
  const setQueueItemAgent = useCallback((queueItemId: string, agentId: string) =>
    request(`/queue/${encodeURIComponent(queueItemId)}`, "PATCH", { agentId }), [request]);
  const runQueueItem = useCallback((queueItemId: string) =>
    request(`/queue/${encodeURIComponent(queueItemId)}/run`, "POST"), [request]);
  const editQueuePrompt = useCallback((queueItemId: string, promptId: string, text: string) =>
    request(`/queue/${encodeURIComponent(queueItemId)}/prompts/${encodeURIComponent(promptId)}`, "PATCH", { text }), [request]);
  const setQueueItemPaused = useCallback((queueItemId: string, paused: boolean) =>
    request(`/queue/${encodeURIComponent(queueItemId)}/pause`, "PATCH", { paused }), [request]);
  const deleteQueueItem = useCallback((queueItemId: string) =>
    request(`/queue/${encodeURIComponent(queueItemId)}`, "DELETE"), [request]);
  const setAutoDispatch = useCallback((autoDispatch: boolean) =>
    request("/routing", "PATCH", { autoDispatch }), [request]);
  const setAutoProvisionAgents = useCallback((autoProvisionAgents: boolean) =>
    request("/routing", "PATCH", { autoProvisionAgents }), [request]);
  const setPersonalAutoAgents = useCallback((autoAgentsEnabled: boolean) => request("/membership", "PATCH", { autoAgentsEnabled }), [request]);
  const setAutoAgentProvider = useCallback(async (autoAgentProvider: import("@/lib/provider-credentials").CredentialProvider | null) => {
    try {
      const response = await fetch(`${BASE_PATH}/api/account/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ defaultApiProvider: autoAgentProvider }) });
      if (!response.ok) { const body = await response.json() as { error?: string }; setError(body.error ?? "Unable to save default API key."); return false; }
      await refresh();
      return true;
    } catch { setError("Unable to save default API key."); return false; }
  }, [refresh]);
  const setAutoResolveConflicts = useCallback((autoResolveConflicts: boolean) =>
    request("/routing", "PATCH", { autoResolveConflicts }), [request]);
  const setAutoInjectFeedback = useCallback((autoInjectFeedback: boolean) =>
    request("/routing", "PATCH", { autoInjectFeedback }), [request]);
  const mutateConflict: import("@/lib/conflict-resolution").ConflictMutation = useCallback(async (caseId, action, input) => {
    let error: string | undefined;
    const result = await request(action === "reload" ? "/floor" : `/conflicts/${encodeURIComponent(caseId)}/${action}`,
      action === "reload" ? "GET" : "POST", input, (message) => { error = message; });
    return { ok: Boolean(result), ...(error ? { error } : {}) };
  }, [request]);
  const cancelRun = useCallback((runId: string) =>
    request(`/runs/${encodeURIComponent(runId)}/cancel`, "POST"), [request]);
  const discardRun = useCallback((runId: string) =>
    request(`/runs/${encodeURIComponent(runId)}/discard`, "POST"), [request]);
  const rollbackRun = useCallback((runId: string) =>
    request(`/runs/${encodeURIComponent(runId)}/rollback`, "POST"), [request]);
  const rollbackReviewChanges = useCallback((input: {
    scope: AgentRunRollbackScope;
    subjectId: string;
    expectedCandidateSha: string;
    expectedRunIds: string[];
  }) => request("/review/rollbacks", "POST", input), [request]);
  const removeReviewFileChanges = useCallback((path: string, expectedCandidateSha: string) =>
    request("/review/files/remove", "POST", { path, expectedCandidateSha }), [request]);
  const retryRun = useCallback((runId: string) =>
    request(`/runs/${encodeURIComponent(runId)}/retry`, "POST"), [request]);
  const readyReview = useCallback(() => request("/review/ready", "POST"), [request]);
  const unreadyReview = useCallback(() => request("/review/draft", "POST"), [request]);
  const syncReview = useCallback(async (options?: { silent?: boolean }) => {
    if (options?.silent) {
      try {
        const response = await fetch(`${BASE_PATH}/api/sessions/${sessionId}/review/sync`, {
          method: "POST",
          cache: "no-store",
        });
        if (response.status === 404) {
          onMissing();
          return null;
        }
        if (!response.ok) return null;
        const result = (await response.json()) as { floor?: FloorSnapshot };
        if (result.floor) {
          setFloor((current) => result.floor!.revision >= current.revision ? result.floor! : current);
          return result.floor;
        }
        return null;
      } catch {
        return null;
      }
    }
    return request("/review/sync", "POST");
  }, [onMissing, request, sessionId]);
  const squashMergeReview = useCallback((deleteCandidateBranch: boolean) =>
    request("/review/merge", "POST", { deleteCandidateBranch }), [request]);
  const setReviewMergeLocked = useCallback((locked: boolean) =>
    request("/review/merge-lock", "PATCH", { locked }), [request]);
  const deleteReviewBranch = useCallback(() => request("/review/branch", "DELETE"), [request]);
  const abandonCandidate = useCallback((deleteBranch: boolean) =>
    request("/repository/candidate", "DELETE", { deleteBranch }), [request]);
  const startRepositoryPreview = useCallback(() => request("/repository/preview", "POST"), [request]);
  const stopRepositoryPreview = useCallback(() => request("/repository/preview", "DELETE"), [request]);

  return useMemo(() => ({
    kind: "persistent" as const,
    floor,
    busy,
    error,
    blockingRunId,
    setError,
    clearError,
    refresh,
    createAgent,
    updateAgentSettings,
    pauseAgent,
    stopAgent,
    deleteAgent,
    pauseAllAgents,
    resumeAllAgents,
    stopAllAgents,
    updateAssignment,
    sendMessage,
    uploadFiles,
    addQueueItem,
    reorderQueue,
    setQueueItemAgent,
    runQueueItem,
    editQueuePrompt,
    setQueueItemPaused,
    deleteQueueItem,
    setAutoDispatch,
    setAutoProvisionAgents,
    setPersonalAutoAgents,
    setAutoAgentProvider,
    setAutoResolveConflicts,
    setAutoInjectFeedback,
    mutateConflict,
    cancelRun,
    discardRun,
    rollbackRun,
    rollbackReviewChanges,
    removeReviewFileChanges,
    retryRun,
    readyReview,
    unreadyReview,
    syncReview,
    squashMergeReview,
    setReviewMergeLocked,
    deleteReviewBranch,
    abandonCandidate,
    startRepositoryPreview,
    stopRepositoryPreview,
  }), [
    floor,
    busy,
    error,
    blockingRunId,
    clearError,
    refresh,
    createAgent,
    updateAgentSettings,
    pauseAgent,
    stopAgent,
    deleteAgent,
    pauseAllAgents,
    resumeAllAgents,
    stopAllAgents,
    updateAssignment,
    sendMessage,
    uploadFiles,
    addQueueItem,
    reorderQueue,
    setQueueItemAgent,
    runQueueItem,
    editQueuePrompt,
    setQueueItemPaused,
    deleteQueueItem,
    setAutoDispatch,
    setAutoProvisionAgents,
    setPersonalAutoAgents,
    setAutoAgentProvider,
    setAutoResolveConflicts,
    setAutoInjectFeedback,
    mutateConflict,
    cancelRun,
    discardRun,
    rollbackRun,
    rollbackReviewChanges,
    removeReviewFileChanges,
    retryRun,
    readyReview,
    unreadyReview,
    syncReview,
    squashMergeReview,
    setReviewMergeLocked,
    deleteReviewBranch,
    abandonCandidate,
    startRepositoryPreview,
    stopRepositoryPreview,
  ]);
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
