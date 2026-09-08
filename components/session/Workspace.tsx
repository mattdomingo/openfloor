"use client";

import { CSSProperties, PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CredentialProvider, ProviderCredentialSummary } from "@/lib/provider-credentials";
import type { AppUser, SessionMember, SessionSummary, TypingDraft } from "@/lib/session-types";
import type { CreateFloorAgentInput, FloorAgentSettingsPatch } from "@/lib/floor-types";
import { countMessagesSinceObjective, countUnreadTeamMessages, latestTeamMessageAt, resolvePersistedAgentMention } from "@/lib/floor-state";
import { GuidedTour, type TourStep } from "@/components/GuidedTour";
import type { AgentConflictInfo, AgentLayout, ChatThread, PanelId, QueueOrderMode, QueueScope, RailId, TeamPanelView, WorkspaceScreen } from "./data";
import { floorParticipants, type PersistentFloorDataSource } from "./usePersistentFloorData";
import type { RepositorySource } from "./useRepositoryTree";
import type { RunActivitySource } from "./useRunActivity";
import { type PanelChrome } from "./Rail";
import { QuotaNotice } from "./QuotaNotice";
import { TopBar } from "./TopBar";
import { BriefRail } from "./BriefRail";
import { AgentFloor } from "./AgentFloor";
import { PromptQueue } from "./PromptQueue";
import { ReviewScreen } from "./ReviewScreen";
import { RollbackImpactDialog, type RollbackIntent } from "./RollbackImpactDialog";
import { FloorDock } from "./FloorDock";
import { StatusBar } from "./StatusLine";
import { useTransientNotice } from "./useTransientNotice";
import { CONFLICT_ALERT_STORAGE_KEY, conflictAttentionEvent, withConflictAlertClaim } from "@/lib/conflict-notifications";

const RAIL_COLLAPSED_WIDTH = 40;
const RAIL_MIN_WIDTH = 250;
const RAIL_MAX_WIDTH = 520;

export function Workspace({ user, session, members, floorData, activity, repositoryTree, typingDrafts, onTypingUpdate, onSaveObjective, agentRunEnabled, repositoryPreviewEnabled, enabledProviders, providerCredentials, presenceConnected, quotaExhausted, lowHoursRemaining }: {
  user: AppUser;
  session: SessionSummary;
  members: SessionMember[];
  floorData: PersistentFloorDataSource;
  activity: RunActivitySource;
  repositoryTree: RepositorySource;
  typingDrafts: ReadonlyMap<string, TypingDraft>;
  onTypingUpdate: (text: string, typing: boolean) => void;
  onSaveObjective: (objective: string | null) => Promise<boolean>;
  agentRunEnabled: boolean;
  repositoryPreviewEnabled: boolean;
  enabledProviders: CredentialProvider[];
  providerCredentials: ProviderCredentialSummary[];
  presenceConnected: boolean;
  quotaExhausted: boolean;
  lowHoursRemaining: number | null;
}) {
  const { agents, assignments, queue, messages, review, preview, runs, repository, activeCandidate } = floorData.floor;
  const participants = useMemo(() => floorParticipants(members, user), [members, user]);
  const [screen, setScreen] = useState<WorkspaceScreen>("workspace");
  const [queueScope, setQueueScope] = useState<QueueScope>("team");
  const [queueOrderMode, setQueueOrderMode] = useState<QueueOrderMode>("auto");
  const [draggedQueueItem, setDraggedQueueItem] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [agentLayout, setAgentLayout] = useState<AgentLayout>("all");
  const [panelOrder, setPanelOrder] = useState<PanelId[]>(["brief", "floor", "queue"]);
  const [railWidths, setRailWidths] = useState<Record<RailId, number>>({ brief: 340, queue: 326 });
  const [collapsedRails, setCollapsedRails] = useState<Record<RailId, boolean>>({ brief: false, queue: false });
  const [expandedPanel, setExpandedPanel] = useState<PanelId | null>(null);
  const [draggedPanel, setDraggedPanel] = useState<PanelId | null>(null);
  const [dragOverPanel, setDragOverPanel] = useState<PanelId | null>(null);
  const [resizing, setResizing] = useState(false);
  // The dock toast's lifetime — dwell then fade, instead of the old plain
  // useState that nothing ever cleared. `setNotice` keeps its name so the
  // ~20 existing call sites below are unchanged.
  const { message: notice, tone: noticeTone, visible: noticeVisible, show: setNotice } = useTransientNotice();
  const [selectedConflictCaseId, setSelectedConflictCaseId] = useState<string | null>(null);
  const [browserConflictAlerts, setBrowserConflictAlerts] = useState(() => typeof window !== "undefined" && window.localStorage.getItem(CONFLICT_ALERT_STORAGE_KEY) === "true");
  const [documentVisibility, setDocumentVisibility] = useState<DocumentVisibilityState>(() => typeof document === "undefined" ? "visible" : document.visibilityState);
  const [queueTarget, setQueueTarget] = useState<string | null>(null);
  const [rollbackIntent, setRollbackIntent] = useState<RollbackIntent | null>(null);
  const [chatThread, setChatThread] = useState<ChatThread>("team");
  const [teamPanelView, setTeamPanelView] = useState<TeamPanelView>("goals");
  const [reviewPromptRequest, setReviewPromptRequest] = useState<{ runId: string; status: "active" | "rolled_back" } | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const selectedAgent = (selectedAgentId ? agents.find((agent) => agent.id === selectedAgentId) : agents[0]) ?? null;
  // FLIP animation for panel swaps: dropPanel captures each slot's rect here
  // right before reordering; the layout effect below then inverts and plays
  // the transform so the swap reads as a smooth slide instead of a jump.
  const panelSlotRefs = useRef<Map<PanelId, HTMLDivElement>>(new Map());
  const prevPanelRectsRef = useRef<Map<PanelId, DOMRect> | null>(null);

  // Read state is a per-device, per-session mark (no server round trip): the
  // Review screen always renders team chat inline too, so it counts as "read"
  // the same as the Team panel's own Chat tab.
  const teamChatVisible = screen === "review" || (screen === "workspace" && teamPanelView === "chat" && chatThread === "team");
  const lastReadStorageKey = `openfloor:lastRead:team:${session.id}`;
  const [lastReadAt, setLastReadAt] = useState(() => {
    if (typeof window === "undefined") return latestTeamMessageAt(messages);
    const stored = Number(window.localStorage.getItem(lastReadStorageKey));
    return Number.isFinite(stored) && stored > 0 ? stored : latestTeamMessageAt(messages);
  });
  // Advance the read mark during render (React's documented pattern for
  // deriving state from a changing condition) so the badge clears in the same
  // render the chat becomes visible, rather than lagging a frame behind an Effect.
  const latestTeamAt = latestTeamMessageAt(messages);
  if (teamChatVisible && latestTeamAt > lastReadAt) setLastReadAt(latestTeamAt);
  // Persisting to localStorage is the actual external-system side effect, so
  // it stays in an Effect — it just never calls setState itself.
  useEffect(() => {
    window.localStorage.setItem(lastReadStorageKey, String(lastReadAt));
  }, [lastReadAt, lastReadStorageKey]);
  const unreadTeamCount = user.doNotDisturb ? 0 : countUnreadTeamMessages(messages, lastReadAt);
  const attentionConflicts = useMemo(
    () => review?.conflicts.filter((conflict) => conflict.status === "awaiting_input" || conflict.status === "failed") ?? [],
    [review?.conflicts],
  );
  // One open case per source agent (a resolver run reuses that agent's own
  // floor_agents row rather than getting its own — see AGENTS.md's Merge
  // Resolver section) so the floor card can show conflict state without any
  // new backend plumbing. "resolved" cases are dropped: once resolved the
  // agent's own latest-run status is what the card should show again.
  const conflictsByAgentId = useMemo(() => {
    const map = new Map<string, AgentConflictInfo>();
    for (const conflict of review?.conflicts ?? []) {
      if (conflict.status === "resolved") continue;
      map.set(conflict.agentId, { caseId: conflict.id, status: conflict.status });
    }
    return map;
  }, [review?.conflicts]);
  function openConflict(caseId: string) {
    setSelectedConflictCaseId(caseId);
    setScreen("review");
  }

  // Folds floorData.error into the same toast lifetime as `notice`, so a
  // mutation failure dwells and fades exactly like any other notice instead
  // of sitting forever — and finally gives floorData.clearError a caller.
  useEffect(() => {
    if (!floorData.error) return;
    setNotice(floorData.error, "error");
    floorData.clearError();
    // Only floorData.error is a meaningful dependency: clearError's identity
    // changes every render (it's an inline closure), but calling it here
    // flips floorData.error back to null, which is what actually re-arms
    // this effect for the next failure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floorData.error, setNotice]);

  useEffect(() => {
    const update = () => setDocumentVisibility(document.visibilityState);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  // ReviewScreen seeds its Prompts-mode selection from reviewPromptRequest on
  // every mount (it fully unmounts whenever screen leaves "review"), so a
  // stale request would otherwise force Prompts mode again the next time the
  // Review nav button — not the queue — opens the screen. Derived during
  // render (same pattern as lastReadAt above) rather than an effect, so it
  // never clears the request the same click just set for onOpenReview below.
  const [screenAtLastPromptClear, setScreenAtLastPromptClear] = useState(screen);
  if (screen !== screenAtLastPromptClear) {
    setScreenAtLastPromptClear(screen);
    if (screen !== "review" && reviewPromptRequest) setReviewPromptRequest(null);
  }

  useEffect(() => {
    if (!browserConflictAlerts || typeof Notification === "undefined" || Notification.permission !== "granted" || documentVisibility !== "hidden") return;
    for (const conflict of attentionConflicts) {
      const eventId = conflictAttentionEvent(conflict);
      if (!eventId) continue;
      void withConflictAlertClaim(eventId, () => {
        const notification = new Notification(conflict.status === "awaiting_input" ? "Merge conflict needs your input" : "Merge Resolver needs attention", {
          body: `${conflict.agentName} · ${conflict.conflictPaths.length} affected file${conflict.conflictPaths.length === 1 ? "" : "s"}`,
          tag: `openfloor-conflict-${conflict.id}`,
        });
        notification.onclick = () => {
          window.focus();
          setSelectedConflictCaseId(conflict.id);
          setScreen("review");
          notification.close();
        };
      });
    }
  }, [attentionConflicts, browserConflictAlerts, documentVisibility]);

  async function setConflictBrowserAlerts(enabled: boolean) {
    if (!enabled) {
      window.localStorage.setItem(CONFLICT_ALERT_STORAGE_KEY, "false");
      setBrowserConflictAlerts(false);
      setNotice("Browser conflict alerts disabled on this device");
      return;
    }
    if (typeof Notification === "undefined") {
      setNotice("This browser does not support notifications");
      return;
    }
    const permission = await Notification.requestPermission();
    const granted = permission === "granted";
    window.localStorage.setItem(CONFLICT_ALERT_STORAGE_KEY, String(granted));
    setBrowserConflictAlerts(granted);
    setNotice(granted ? "Browser conflict alerts enabled on this device" : "Browser notification permission was not granted");
  }

  async function createAgent(input: CreateFloorAgentInput) {
    const before = new Set(agents.map((agent) => agent.id));
    const floor = await floorData.createAgent(input);
    if (!floor) return false;
    const created = floor.agents.find((agent) => !before.has(agent.id));
    if (created) setSelectedAgentId(created.id);
    setAgentLayout("focus");
    setNotice(`${created?.name ?? input.name} created`);
    return true;
  }

  async function enqueuePrompt(value: string) {
    const prompt = value.trim();
    if (!prompt) return false;
    const mentioned = resolvePersistedAgentMention(prompt, agents);
    const agentId = mentioned?.id ?? queueTarget;
    const floor = await floorData.addQueueItem(prompt, agentId);
    if (!floor) return false;
    setCollapsedRails((current) => ({ ...current, queue: false }));
    setNotice(agentId ? `Prompt queued for ${floor.agents.find((agent) => agent.id === agentId)?.name ?? "agent"}` : "Prompt queued without an agent");
    return true;
  }

  async function dropQueueItem(targetId: string) {
    if (!draggedQueueItem || draggedQueueItem === targetId) { setDraggedQueueItem(null); return; }
    const ids = queue.map((item) => item.id).filter((id) => id !== draggedQueueItem);
    ids.splice(ids.indexOf(targetId), 0, draggedQueueItem);
    setDraggedQueueItem(null);
    if (await floorData.reorderQueue(ids)) setNotice("Queue order saved");
  }

  function movePanel(panel: PanelId, direction: -1 | 1) {
    setPanelOrder((current) => { const next = [...current]; const index = next.indexOf(panel); const target = index + direction; if (target < 0 || target >= next.length) return current; [next[index], next[target]] = [next[target], next[index]]; return next; });
  }

  // Swap, not insert-before: the previous filter+splice recomputed the
  // target's index in the array with the dragged panel already removed, so a
  // rightward drop (target after source) landed one slot short of the target
  // — dragging the leftmost panel onto its immediate right neighbor was a
  // silent no-op. Swapping the two indices directly has no such directional bug.
  // Insert-and-shift, not a two-item swap: the dragged panel lands exactly
  // where it's dropped and every panel between its old and new spot slides
  // over by one — `to` is the target's index in the pre-removal array, so
  // splice's own semantics place it correctly on either side without an
  // off-by-one (that bias bit the old swap-by-index version too).
  function dropPanel(target: PanelId) {
    setDragOverPanel(null);
    if (!draggedPanel || draggedPanel === target) return;
    const rects = new Map<PanelId, DOMRect>();
    panelSlotRefs.current.forEach((element, id) => rects.set(id, element.getBoundingClientRect()));
    prevPanelRectsRef.current = rects;
    setPanelOrder((current) => {
      const from = current.indexOf(draggedPanel);
      const to = current.indexOf(target);
      const next = [...current];
      next.splice(from, 1);
      next.splice(to, 0, draggedPanel);
      return next;
    });
    setDraggedPanel(null);
  }

  // FLIP: panelOrder just changed the DOM order (React moves the existing
  // nodes since each keeps its `key`), which would otherwise jump instantly.
  // Translate each slot back to where it was, force a reflow, then release
  // the transform so .panel-slot's own transition animates it into place.
  useLayoutEffect(() => {
    const prevRects = prevPanelRectsRef.current;
    if (!prevRects) return;
    prevPanelRectsRef.current = null;
    panelSlotRefs.current.forEach((element, id) => {
      const prev = prevRects.get(id);
      if (!prev) return;
      const next = element.getBoundingClientRect();
      const dx = prev.left - next.left;
      const dy = prev.top - next.top;
      if (!dx && !dy) return;
      element.style.transition = "none";
      element.style.transform = `translate(${dx}px, ${dy}px)`;
      element.getBoundingClientRect();
      requestAnimationFrame(() => {
        element.style.transition = "";
        element.style.transform = "";
      });
    });
  }, [panelOrder]);

  function startResize(left: PanelId, right: PanelId, event: ReactPointerEvent<HTMLDivElement>) {
    const rail: RailId | null = left !== "floor" ? left : right !== "floor" ? right : null;
    if (!rail || collapsedRails[rail]) return;
    const direction = rail === left ? 1 : -1;
    const startX = event.clientX;
    const startWidth = railWidths[rail];
    setResizing(true);
    const onMove = (moveEvent: PointerEvent) => setRailWidths((current) => ({ ...current, [rail]: Math.max(RAIL_MIN_WIDTH, Math.min(RAIL_MAX_WIDTH, startWidth + direction * (moveEvent.clientX - startX))) }));
    const onUp = () => { setResizing(false); window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
  }

  function isCollapsed(panel: PanelId) { return panel !== "floor" && collapsedRails[panel] && expandedPanel !== panel; }
  function slotStyle(panel: PanelId): CSSProperties { if (expandedPanel === panel) return { flex: "1 1 100%" }; if (panel === "floor") return { flex: "1 1 0" }; return { flex: `0 1 ${isCollapsed(panel) ? RAIL_COLLAPSED_WIDTH : railWidths[panel]}px` }; }
  function chromeFor(panel: PanelId, index: number): PanelChrome { return { id: panel, index, count: panelOrder.length, expanded: expandedPanel === panel, collapsible: panel !== "floor", collapsed: isCollapsed(panel), onMove: (direction) => movePanel(panel, direction), onExpand: () => setExpandedPanel(expandedPanel === panel ? null : panel), onCollapse: () => { if (panel !== "floor") setCollapsedRails((current) => ({ ...current, [panel]: !current[panel] })); }, onDragStart: () => setDraggedPanel(panel), onDragEnd: () => { setDraggedPanel(null); setDragOverPanel(null); } }; }

  const {
    updateAssignment,
    sendMessage,
    setQueueItemAgent,
    setAutoDispatch,
    setAutoResolveConflicts,
    setAutoInjectFeedback,
    runQueueItem,
    cancelRun,
    discardRun,
    retryRun,
    editQueuePrompt,
    setQueueItemPaused,
    deleteQueueItem,
    setAutoProvisionAgents,
    setAutoAgentProvider,
    updateAgentSettings,
    pauseAgent,
    stopAgent,
    deleteAgent,
    pauseAllAgents,
    resumeAllAgents,
    stopAllAgents,
    resolveConflict,
    answerConflict,
    submitConflictSelections,
    syncReview,
    readyReview,
    unreadyReview,
    squashMergeReview,
    setReviewMergeLocked,
    deleteReviewBranch,
    abandonCandidate,
    uploadFiles,
  } = floorData;

  const handleAssignmentChange = useCallback(async (id: string, task: string | null) => {
    return Boolean(await updateAssignment(id, task));
  }, [updateAssignment]);

  const handleSendMessage = useCallback(async (text: string, recipient: string | null, attachmentIds?: string[]) => {
    return Boolean(await sendMessage(text, recipient, attachmentIds));
  }, [sendMessage]);

  const handleSetQueueAgent = useCallback(async (queueItemId: string, agentId: string) => {
    const result = await setQueueItemAgent(queueItemId, agentId);
    if (result) setNotice("Prompt targeted");
  }, [setQueueItemAgent, setNotice]);

  const handleAutoDispatch = useCallback(async (enabled: boolean) => {
    const result = await setAutoDispatch(enabled);
    if (result) setNotice(enabled ? "Auto-dispatch enabled" : "Auto-dispatch disabled");
  }, [setAutoDispatch, setNotice]);

  const handleAutoResolveConflicts = useCallback(async (enabled: boolean) => {
    const result = await setAutoResolveConflicts(enabled);
    if (result) setNotice(enabled ? "Automatic conflict resolution enabled" : "Automatic conflict resolution disabled");
  }, [setAutoResolveConflicts, setNotice]);

  const handleAutoInjectFeedback = useCallback(async (enabled: boolean) => {
    const result = await setAutoInjectFeedback(enabled);
    if (result) setNotice(enabled ? "PR feedback nudges enabled" : "PR feedback nudges disabled");
  }, [setAutoInjectFeedback, setNotice]);

  const handleRunQueueItem = useCallback(async (id: string) => {
    const result = await runQueueItem(id);
    if (result) setNotice("Agent run started");
  }, [runQueueItem, setNotice]);

  const handleCancelRun = useCallback(async (id: string) => {
    const result = await cancelRun(id);
    if (result) setNotice("Cancellation requested");
  }, [cancelRun, setNotice]);

  const handleDiscardRun = useCallback(async (id: string) => {
    const result = await discardRun(id);
    if (result) setNotice("Verified run branch discarded");
  }, [discardRun, setNotice]);

  const handleRollbackRun = useCallback((runId: string) => {
    setRollbackIntent({ scope: "prompt", subjectId: runId });
    return Promise.resolve();
  }, []);

  const handleRetryRun = useCallback(async (id: string) => {
    const result = await retryRun(id);
    if (result) setNotice("Retry started against the latest candidate");
  }, [retryRun, setNotice]);

  const handleEditQueuePrompt = useCallback(async (queueItemId: string, promptId: string, text: string) => {
    const result = await editQueuePrompt(queueItemId, promptId, text);
    if (result) setNotice("Prompt updated");
    return Boolean(result);
  }, [editQueuePrompt, setNotice]);

  const handlePauseQueueItem = useCallback(async (queueItemId: string, paused: boolean) => {
    const result = await setQueueItemPaused(queueItemId, paused);
    if (result) setNotice(paused ? "Prompt paused" : "Prompt resumed");
  }, [setQueueItemPaused, setNotice]);

  const handleDeleteQueueItem = useCallback(async (queueItemId: string) => {
    const result = await deleteQueueItem(queueItemId);
    if (result) setNotice("Prompt removed");
  }, [deleteQueueItem, setNotice]);

  const handleFocusAgent = useCallback((agentId: string) => {
    if (!agents.some((agent) => agent.id === agentId)) return;
    setSelectedAgentId(agentId);
    setAgentLayout("focus");
  }, [agents]);

  const handleOpenReview = useCallback((runId: string, status: "active" | "rolled_back") => {
    setReviewPromptRequest({ runId, status });
    setScreen("review");
  }, []);

  const handleAutoProvisionAgents = useCallback(async (enabled: boolean) => {
    return Boolean(await setAutoProvisionAgents(enabled));
  }, [setAutoProvisionAgents]);

  const handleAutoAgentProvider = useCallback(async (provider: CredentialProvider | null) => {
    return Boolean(await setAutoAgentProvider(provider));
  }, [setAutoAgentProvider]);

  const handleUpdateSettings = useCallback(async (agentId: string, patch: FloorAgentSettingsPatch) => {
    return Boolean(await updateAgentSettings(agentId, patch));
  }, [updateAgentSettings]);

  const handlePauseAgent = useCallback((agentId: string, paused: boolean) => {
    void (async () => {
      const result = await pauseAgent(agentId, paused);
      if (result) setNotice(paused ? "Agent paused" : "Agent resumed");
    })();
  }, [pauseAgent, setNotice]);

  const handleStopAgent = useCallback((agentId: string) => {
    void (async () => {
      const result = await stopAgent(agentId);
      if (result) setNotice("Agent stopped");
    })();
  }, [stopAgent, setNotice]);

  const handleDeleteAgent = useCallback((agentId: string) => {
    void (async () => {
      const result = await deleteAgent(agentId);
      if (result) setNotice("Agent removed");
    })();
  }, [deleteAgent, setNotice]);

  const handlePauseAllAgents = useCallback(async () => {
    const result = await pauseAllAgents();
    if (result) setNotice("All agents paused");
  }, [pauseAllAgents, setNotice]);

  const handleResumeAllAgents = useCallback(async () => {
    const result = await resumeAllAgents();
    if (result) setNotice("Your agents resumed");
  }, [resumeAllAgents, setNotice]);

  const handleStopAllAgents = useCallback(async () => {
    const result = await stopAllAgents();
    if (result) setNotice("All agents stopped");
  }, [stopAllAgents, setNotice]);

  const handleResolveConflict = useCallback(async (caseId: string) => {
    return Boolean(await resolveConflict(caseId));
  }, [resolveConflict]);

  const handleAnswerConflict = useCallback(async (caseId: string, answers: Array<{ questionId: string; answer: string }>) => {
    return Boolean(await answerConflict(caseId, answers));
  }, [answerConflict]);

  const handleSubmitConflictSelections = useCallback(async (caseId: string, snapshotRunId: string, selections: Array<{ path: string; hunkIndex: number; choice: import("@/lib/floor-types").ConflictChoice }>) => {
    return Boolean(await submitConflictSelections(caseId, snapshotRunId, selections));
  }, [submitConflictSelections]);

  const handleSyncReview = useCallback(async (options?: { silent?: boolean }) => {
    const result = await syncReview(options);
    if (result && !options?.silent) setNotice("GitHub review status synchronized");
    return Boolean(result);
  }, [setNotice, syncReview]);

  const handleReadyReview = useCallback(async () => {
    if (await readyReview()) setNotice("Pull request marked ready for review");
  }, [readyReview, setNotice]);

  const handleUnreadyReview = useCallback(async () => {
    if (await unreadyReview()) setNotice("Pull request converted back to a draft");
  }, [unreadyReview, setNotice]);

  const handleMergeReview = useCallback(async (deleteCandidateBranch: boolean) => {
    const result = await squashMergeReview(deleteCandidateBranch);
    if (result) setNotice(deleteCandidateBranch ? "Pull request squash merged and branches cleaned up" : "Pull request squash merged; candidate branch kept");
    return Boolean(result);
  }, [squashMergeReview, setNotice]);

  const handleReviewMergeLock = useCallback(async (locked: boolean) => {
    const result = await setReviewMergeLocked(locked);
    if (result) setNotice(locked ? "Squash merge locked" : "Squash merge unlocked");
  }, [setReviewMergeLocked, setNotice]);

  const handleDeleteReviewBranch = useCallback(async () => {
    const result = await deleteReviewBranch();
    if (result) setNotice("Candidate branch deleted");
    return Boolean(result);
  }, [deleteReviewBranch, setNotice]);

  const handleAbandonReviewCandidate = useCallback(async (deleteBranch: boolean) => {
    const result = await abandonCandidate(deleteBranch);
    if (result) setNotice(deleteBranch ? "Candidate abandoned and branch deleted" : "Candidate abandoned; branch kept");
    return Boolean(result);
  }, [abandonCandidate, setNotice]);

  const handleCancelReviewRun = useCallback(async (runId: string) => {
    await cancelRun(runId);
  }, [cancelRun]);

  const handleSendReviewTeamMessage = useCallback(async (text: string, recipient: string | null) => {
    return Boolean(await sendMessage(text, recipient));
  }, [sendMessage]);

  const handleStartRepositoryPreview = useCallback(async () => {
    const result = await floorData.startRepositoryPreview();
    if (result) setNotice(preview?.url ? "Preview rebuild started" : "Preview build started");
    return Boolean(result);
  }, [floorData, preview?.url, setNotice]);

  const handleStopRepositoryPreview = useCallback(async () => {
    const result = await floorData.stopRepositoryPreview();
    if (result) setNotice("Preview stopped");
    return Boolean(result);
  }, [floorData, setNotice]);

  function renderPanel(panel: PanelId, chrome: PanelChrome) {
    if (panel === "brief") return <BriefRail chrome={chrome} sessionId={session.id} assignments={assignments} agents={agents} queue={queue} onAssignmentChange={handleAssignmentChange} view={teamPanelView} onViewChange={setTeamPanelView} messages={messages} onSendMessage={handleSendMessage} chatThread={chatThread} onChatThreadChange={setChatThread} participants={participants} currentUserId={user.id} unreadTeamCount={unreadTeamCount} files={floorData.floor.files} onUploadFiles={uploadFiles} />;
    if (panel === "queue") return <PromptQueue chrome={chrome} items={queue} runs={runs} agents={agents} owner={session.role === "owner"} runEnabled={agentRunEnabled} busy={floorData.busy} autoDispatch={floorData.floor.autoDispatch} onSetAgent={handleSetQueueAgent} onAutoDispatch={handleAutoDispatch} autoResolveConflicts={floorData.floor.autoResolveConflicts} onAutoResolveConflicts={handleAutoResolveConflicts} autoInjectFeedback={floorData.floor.autoInjectFeedback} onAutoInjectFeedback={handleAutoInjectFeedback} browserConflictAlerts={browserConflictAlerts} onBrowserConflictAlerts={setConflictBrowserAlerts} onRun={handleRunQueueItem} onCancel={handleCancelRun} onDiscard={handleDiscardRun} onRollback={handleRollbackRun} onRetry={handleRetryRun} onEditPrompt={handleEditQueuePrompt} onPause={handlePauseQueueItem} onDelete={handleDeleteQueueItem} currentUserId={user.id} scope={queueScope} onScope={setQueueScope} orderMode={queueOrderMode} onOrderMode={setQueueOrderMode} draggedItemId={draggedQueueItem} onItemDragStart={setDraggedQueueItem} onItemDragEnd={() => setDraggedQueueItem(null)} onItemDrop={(id) => void dropQueueItem(id)} onFocusAgent={handleFocusAgent} onOpenReview={handleOpenReview} />;
    return <AgentFloor chrome={chrome} sessionId={session.id} agents={agents} runs={runs} activity={activity} selected={selectedAgent} onSelect={setSelectedAgentId} agentLayout={agentLayout} onAgentLayout={setAgentLayout} onCreateAgent={createAgent} enabledProviders={enabledProviders} providerCredentials={providerCredentials} owner={session.role === "owner"} autoDispatch={floorData.floor.autoDispatch} personalAutoAgentsEnabled={floorData.floor.personalAutoAgentsEnabled ?? true} onPersonalAutoAgents={async (enabled) => Boolean(await floorData.setPersonalAutoAgents(enabled))} autoProvisionAgents={floorData.floor.autoProvisionAgents} autoAgentProvider={floorData.floor.autoAgentProvider} effectiveAutoAgentProvider={floorData.floor.effectiveAutoAgentProvider} autoAgentProviderState={floorData.floor.autoAgentProviderState} onAutoProvisionAgents={handleAutoProvisionAgents} onAutoAgentProvider={handleAutoAgentProvider} onUpdateSettings={handleUpdateSettings} onPauseAgent={handlePauseAgent} onStopAgent={handleStopAgent} onDeleteAgent={handleDeleteAgent} onPauseAllAgents={handlePauseAllAgents} onResumeAllAgents={handleResumeAllAgents} onStopAllAgents={handleStopAllAgents} agentControlsBusy={floorData.busy} queue={queue} currentUserId={user.id} conflictsByAgentId={conflictsByAgentId} onOpenConflict={openConflict} />;
  }

  return <main className="app-shell" data-screen={screen}>
    <TopBar screen={screen} onScreen={setScreen} onNotice={setNotice} session={session} user={user} members={members} unreadTeamCount={unreadTeamCount} reviewAttentionCount={attentionConflicts.length} presenceConnected={presenceConnected} staleMessageCount={countMessagesSinceObjective(messages, session.objectiveUpdatedAt)} onSaveObjective={onSaveObjective} repository={repository} branch={activeCandidate?.branchName ?? repository?.baseBranch ?? null} />
    {quotaExhausted && session.endedAt == null && <QuotaNotice sessionId={session.id} role={session.role} />}
    {!quotaExhausted && session.endedAt == null && lowHoursRemaining != null && (
      <QuotaNotice sessionId={session.id} role={session.role} remainingSeconds={lowHoursRemaining} />
    )}
    {screen !== "review" && attentionConflicts[0] && <button type="button" className="notice conflict-attention-banner" data-tone="attention" onClick={() => openConflict(attentionConflicts[0].id)}><strong>{attentionConflicts[0].status === "awaiting_input" ? "Merge conflict needs a decision" : "Merge Resolver needs attention"}</strong><span>Open Review to see the conflict and {attentionConflicts[0].status === "awaiting_input" ? "answer its questions" : "retry resolution"}.</span></button>}
    {screen === "review" ? <ReviewScreen sessionId={session.id} revision={floorData.floor.revision} review={review} preview={preview} previewEnabled={repositoryPreviewEnabled} repository={repository} repositoryTree={repositoryTree} selectedConflictCaseId={selectedConflictCaseId} promptRequest={reviewPromptRequest} owner={session.role === "owner"} busy={floorData.busy} blockingRunId={floorData.blockingRunId} onStartPreview={handleStartRepositoryPreview} onStopPreview={handleStopRepositoryPreview} onRequestRollback={setRollbackIntent} onResolveConflict={handleResolveConflict} onAnswerConflict={handleAnswerConflict} onSubmitConflictSelections={handleSubmitConflictSelections} onSync={handleSyncReview} onReady={handleReadyReview} onUnready={handleUnreadyReview} onMerge={handleMergeReview} onMergeLock={handleReviewMergeLock} onDeleteBranch={handleDeleteReviewBranch} onAbandon={handleAbandonReviewCandidate} onCancelRun={handleCancelReviewRun} teamChat={messages} onSendTeamMessage={handleSendReviewTeamMessage} participants={participants} currentUserId={user.id} sessionFiles={floorData.floor.files} /> : <><div className="workspace" data-expanded={expandedPanel ? "true" : "false"} data-resizing={resizing ? "true" : "false"}>{panelOrder.map((panel, index) => { const next = panelOrder[index + 1]; const showHandle = !expandedPanel && next !== undefined && !(isCollapsed(panel) && panel !== "floor"); return <div key={panel} ref={(element) => { if (element) panelSlotRefs.current.set(panel, element); else panelSlotRefs.current.delete(panel); }} className="panel-slot" style={slotStyle(panel)} data-expanded={expandedPanel === panel ? "true" : "false"} data-collapsed={isCollapsed(panel) ? "true" : "false"} data-dragging={draggedPanel === panel ? "true" : "false"} data-drop-target={dragOverPanel === panel ? "true" : "false"} onDragOver={(event) => { event.preventDefault(); if (draggedPanel && draggedPanel !== panel) setDragOverPanel(panel); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOverPanel((current) => current === panel ? null : current); }} onDrop={() => dropPanel(panel)}>{renderPanel(panel, chromeFor(panel, index))}{showHandle && <div className="resize-handle" role="separator" aria-label={`Resize ${panel} panel`} onPointerDown={(event) => startResize(panel, next, event)} />}</div>; })}</div><FloorDock onSubmit={enqueuePrompt} onUploadFiles={uploadFiles} agents={agents} queueTarget={queueTarget} onQueueTargetChange={setQueueTarget} textareaRef={composerRef} notice={notice} noticeTone={noticeTone} noticeVisible={noticeVisible} busy={floorData.busy} participants={participants} typingDrafts={typingDrafts} onTypingUpdate={onTypingUpdate} /></>}
    {rollbackIntent && <RollbackImpactDialog sessionId={session.id} intent={rollbackIntent} busy={floorData.busy} onClose={() => setRollbackIntent(null)} onConfirm={async (impact) => { const result = await floorData.rollbackReviewChanges({ scope: impact.scope, subjectId: impact.subjectId, expectedCandidateSha: impact.expectedCandidateSha, expectedRunIds: impact.targets.map((target) => target.runId) }); if (result) setNotice("Candidate rollback started"); return Boolean(result); }} />}
    {screen === "review" && notice && <StatusBar notice={notice} visible={noticeVisible} tone={noticeTone} />}
    {screen === "workspace" && <GuidedTour storageKey={`openfloor:tutorial:floor:${user.id}`} steps={FLOOR_TOUR} />}
  </main>;
}

// First-visit walkthrough of the floor (ENG-17). Anchored to the panels'
// aria-labels, which are stable regardless of the member's panel order.
const FLOOR_TOUR: TourStep[] = [
  {
    selector: 'section[aria-label="Team"]',
    title: "Team",
    body: "Goals, assignments, and team chat. Everyone in the session works on this same shared floor — it survives reloads and reconnects.",
  },
  {
    selector: 'section[aria-label="Agent floor"]',
    title: "Agents",
    body: "Named agents owned by real teammates do the coding. Click one to open its spotlight: task, model, latest run, and cost.",
  },
  {
    selector: 'section[aria-label="Queue"]',
    title: "The queue",
    body: "Prompts wait here as the team's shared backlog. Target an agent, reorder, or merge related prompts before they run.",
  },
  {
    selector: 'section[aria-label="Open floor"]',
    title: "Send work",
    body: "Write a prompt to add it to the queue; mention an agent to target it. Teammates can watch live drafts as you type.",
  },
  {
    selector: 'nav[aria-label="Workspace screens"]',
    title: "Review",
    body: "When runs land on the candidate branch, Review is where the team inspects changes, resolves conflicts, and squash-merges the pull request.",
  },
];
