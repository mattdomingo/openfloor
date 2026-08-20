"use client";

import { CSSProperties, PointerEvent as ReactPointerEvent, useMemo, useRef, useState } from "react";
import { LocalDateTime } from "@/components/LocalDateTime";
import type { AppUser, SessionMember, SessionSummary, TypingDraft } from "@/lib/session-types";
import type { CreateFloorAgentInput } from "@/lib/floor-types";
import { firstMergeableQueueGroup, resolvePersistedAgentMention } from "@/lib/floor-state";
import type { AgentLayout, ChatThread, PanelId, QueueMergeMode, QueueOrderMode, QueueScope, RailId, TeamPanelView, WorkspaceScreen } from "./data";
import { floorParticipants, type PersistentFloorDataSource } from "./usePersistentFloorData";
import type { RunActivitySource } from "./useRunActivity";
import { type PanelChrome } from "./Rail";
import { TopBar } from "./TopBar";
import { ObjectiveBar } from "./ObjectiveBar";
import { BriefRail } from "./BriefRail";
import { AgentFloor } from "./AgentFloor";
import { PromptQueue } from "./PromptQueue";
import { ReviewScreen } from "./ReviewScreen";
import { FloorDock } from "./FloorDock";
import { StatusBar } from "./StatusLine";

const RAIL_COLLAPSED_WIDTH = 40;
const RAIL_MIN_WIDTH = 250;
const RAIL_MAX_WIDTH = 520;

export function Workspace({ user, session, members, floorData, activity, typingDrafts, onTypingUpdate, onSaveObjective, agentRunEnabled }: {
  user: AppUser;
  session: SessionSummary;
  members: SessionMember[];
  floorData: PersistentFloorDataSource;
  activity: RunActivitySource;
  typingDrafts: ReadonlyMap<string, TypingDraft>;
  onTypingUpdate: (text: string, typing: boolean) => void;
  onSaveObjective: (objective: string | null) => Promise<boolean>;
  agentRunEnabled: boolean;
}) {
  const { agents, assignments, queue, messages, review, runs } = floorData.floor;
  const participants = useMemo(() => floorParticipants(members, user), [members, user]);
  const [screen, setScreen] = useState<WorkspaceScreen>("workspace");
  const [queueScope, setQueueScope] = useState<QueueScope>("team");
  const [queueOrderMode, setQueueOrderMode] = useState<QueueOrderMode>("auto");
  const [queueMergeMode, setQueueMergeMode] = useState<QueueMergeMode>("off");
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
  const [notice, setNotice] = useState<string | null>(null);
  const [queueTarget, setQueueTarget] = useState<string | null>(null);
  const [chatThread, setChatThread] = useState<ChatThread>("team");
  const [teamPanelView, setTeamPanelView] = useState<TeamPanelView>("goals");
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? agents[0] ?? null;

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
    if (queueMergeMode === "auto") {
      const matching = floor.queue.filter((item) => item.status === "queued" && item.agentId === agentId).map((item) => item.id);
      if (matching.length > 1 && !(await floorData.mergeQueue(matching))) return false;
    }
    setQueueScope("mine");
    setCollapsedRails((current) => ({ ...current, queue: false }));
    setNotice(agentId ? `Prompt queued for ${floor.agents.find((agent) => agent.id === agentId)?.name ?? "agent"}` : "Prompt queued without an agent");
    return true;
  }

  async function mergeQueueNow() {
    const group = firstMergeableQueueGroup(queue);
    if (group.length < 2) { setNotice("Nothing to merge · queue targets must match"); return; }
    if (await floorData.mergeQueue(group)) setNotice(`${group.length} queue items merged`);
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

  function dropPanel(target: PanelId) {
    setDragOverPanel(null);
    if (!draggedPanel || draggedPanel === target) return;
    setPanelOrder((current) => { const next = current.filter((id) => id !== draggedPanel); next.splice(next.indexOf(target), 0, draggedPanel); return next; });
    setDraggedPanel(null);
  }

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

  function renderPanel(panel: PanelId, chrome: PanelChrome) {
    if (panel === "brief") return <BriefRail chrome={chrome} assignments={assignments} agents={agents} queue={queue} onAssignmentChange={async (id, task) => Boolean(await floorData.updateAssignment(id, task))} view={teamPanelView} onViewChange={setTeamPanelView} messages={messages} onSendMessage={async (text, recipient) => Boolean(await floorData.sendMessage(text, recipient))} chatThread={chatThread} onChatThreadChange={setChatThread} participants={participants} currentUserId={user.id} />;
    if (panel === "queue") return <PromptQueue chrome={chrome} items={queue} runs={runs} owner={session.role === "owner"} runEnabled={agentRunEnabled} busy={floorData.busy} autoDispatch={floorData.floor.autoDispatch} onAutoDispatch={async (enabled) => { const result = await floorData.setAutoDispatch(enabled); if (result) setNotice(enabled ? "Auto-dispatch enabled" : "Auto-dispatch disabled"); }} onRun={async (id) => { const result = await floorData.runQueueItem(id); if (result) setNotice("Agent run started"); }} onCancel={async (id) => { const result = await floorData.cancelRun(id); if (result) setNotice("Cancellation requested"); }} onDiscard={async (id) => { const result = await floorData.discardRun(id); if (result) setNotice("Verified run branch discarded"); }} onRetry={async (id) => { const result = await floorData.retryRun(id); if (result) setNotice("Retry started against the latest candidate"); }} onEditPrompt={async (queueItemId, promptId, text) => { const result = await floorData.editQueuePrompt(queueItemId, promptId, text); if (result) setNotice("Prompt updated"); return Boolean(result); }} onPause={async (queueItemId, paused) => { const result = await floorData.setQueueItemPaused(queueItemId, paused); if (result) setNotice(paused ? "Prompt paused" : "Prompt resumed"); }} onDelete={async (queueItemId) => { const result = await floorData.deleteQueueItem(queueItemId); if (result) setNotice("Prompt removed"); }} currentUserId={user.id} scope={queueScope} onScope={setQueueScope} orderMode={queueOrderMode} onOrderMode={setQueueOrderMode} mergeMode={queueMergeMode} onMergeMode={setQueueMergeMode} onMergeNow={() => void mergeQueueNow()} draggedItemId={draggedQueueItem} onItemDragStart={setDraggedQueueItem} onItemDragEnd={() => setDraggedQueueItem(null)} onItemDrop={(id) => void dropQueueItem(id)} onFocusAgent={(agentId) => { setSelectedAgentId(agentId); setAgentLayout("focus"); }} />;
    return <AgentFloor chrome={chrome} sessionId={session.id} agents={agents} runs={runs} activity={activity} selected={selectedAgent} onSelect={setSelectedAgentId} agentLayout={agentLayout} onAgentLayout={setAgentLayout} onCreateAgent={createAgent} onUpdateTask={async (agentId, task) => Boolean(await floorData.updateAgentTask(agentId, task))} queue={queue} participants={participants} currentUserId={user.id} />;
  }

  return <main className="app-shell" data-screen={screen}>
    <TopBar screen={screen} onScreen={setScreen} onNotice={setNotice} session={session} user={user} members={members} />
    {session.endedAt != null && (
      /* Banner only: the server-side write guard is the enforcement, so a
         stale control just surfaces its 409 through the dock status line. */
      <p className="notice" data-tone="attention" role="status">This session ended <LocalDateTime timestamp={session.endedAt} mode="date" />. The floor is read-only.</p>
    )}
    <ObjectiveBar objective={session.objective} updatedAt={session.updatedAt} onSave={onSaveObjective} />
    {screen === "review" ? <ReviewScreen review={review} owner={session.role === "owner"} busy={floorData.busy} onReady={async () => { if (await floorData.readyReview()) setNotice("GitHub review status synchronized"); }} onMerge={async () => { if (await floorData.squashMergeReview()) setNotice("Pull request squash merged and verified branches cleaned up"); }} teamChat={messages} onSendTeamMessage={async (text, recipient) => Boolean(await floorData.sendMessage(text, recipient))} participants={participants} currentUserId={user.id} /> : <><div className="workspace" data-expanded={expandedPanel ? "true" : "false"} data-resizing={resizing ? "true" : "false"}>{panelOrder.map((panel, index) => { const next = panelOrder[index + 1]; const showHandle = !expandedPanel && next !== undefined && !(isCollapsed(panel) && panel !== "floor"); return <div key={panel} className="panel-slot" style={slotStyle(panel)} data-expanded={expandedPanel === panel ? "true" : "false"} data-collapsed={isCollapsed(panel) ? "true" : "false"} data-dragging={draggedPanel === panel ? "true" : "false"} data-drop-target={dragOverPanel === panel ? "true" : "false"} onDragOver={(event) => { event.preventDefault(); if (draggedPanel && draggedPanel !== panel) setDragOverPanel(panel); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOverPanel((current) => current === panel ? null : current); }} onDrop={() => dropPanel(panel)}>{renderPanel(panel, chromeFor(panel, index))}{showHandle && <div className="resize-handle" role="separator" aria-label={`Resize ${panel} panel`} onPointerDown={(event) => startResize(panel, next, event)} />}</div>; })}</div><FloorDock onSubmit={enqueuePrompt} agents={agents} queueTarget={queueTarget} onQueueTargetChange={setQueueTarget} textareaRef={composerRef} notice={notice} error={floorData.error} busy={floorData.busy} user={user} participants={participants} typingDrafts={typingDrafts} onTypingUpdate={onTypingUpdate} /></>}
    {screen === "review" && (notice || floorData.error) && <StatusBar notice={floorData.error ?? notice ?? ""} visible tone={floorData.error ? "error" : "notice"} />}
  </main>;
}
