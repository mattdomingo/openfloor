"use client";

import { CSSProperties, PointerEvent as ReactPointerEvent, useMemo, useRef, useState } from "react";
import type { AppUser, SessionMember, SessionSummary } from "@/lib/session-types";
import {
  Agent,
  AgentDraft,
  AgentLayout,
  ChatMessage,
  ChatThread,
  PanelId,
  QueueItem,
  QueueMergeMode,
  QueueOrderMode,
  QueueScope,
  RailId,
  TeamPanelView,
  WorkspaceScreen,
  checks,
  pickAgentForOpenMind,
  resolveAgentMention,
  routableAgents,
} from "./data";
import { usePrototypeFloorData } from "./usePrototypeFloorData";
import { PanelChrome } from "./Rail";
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

export function Workspace({
  user,
  session,
  members,
  onSaveObjective,
}: {
  user: AppUser;
  session: SessionSummary;
  members: SessionMember[];
  onSaveObjective: (objective: string | null) => Promise<boolean>;
}) {
  const dataSource = usePrototypeFloorData(members, user);
  const { agents, assignments, queue, messages: teamChat, participants } = dataSource.snapshot;
  const [screen, setScreen] = useState<WorkspaceScreen>("workspace");
  const [queueScope, setQueueScope] = useState<QueueScope>("team");
  const [queueOrderMode, setQueueOrderMode] = useState<QueueOrderMode>("auto");
  const [queueMergeMode, setQueueMergeMode] = useState<QueueMergeMode>("off");
  const [manualQueueOrder, setManualQueueOrder] = useState<string[]>([]);
  const [draggedQueueItem, setDraggedQueueItem] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState(agents[0]?.id ?? "");
  const [conflictResolved, setConflictResolved] = useState(false);
  const [agentLayout, setAgentLayout] = useState<AgentLayout>("all");
  const [panelOrder, setPanelOrder] = useState<PanelId[]>(["brief", "floor", "queue"]);
  const [railWidths, setRailWidths] = useState<Record<RailId, number>>({ brief: 340, queue: 326 });
  const [collapsedRails, setCollapsedRails] = useState<Record<RailId, boolean>>({ brief: false, queue: false });
  const [expandedPanel, setExpandedPanel] = useState<PanelId | null>(null);
  const [draggedPanel, setDraggedPanel] = useState<PanelId | null>(null);
  const [dragOverPanel, setDragOverPanel] = useState<PanelId | null>(null);
  const [resizing, setResizing] = useState(false);
  const [notice, setNotice] = useState("Prototype agent state is ready");
  const [queueTarget, setQueueTarget] = useState<string | null>(null);
  const [chatThread, setChatThread] = useState<ChatThread>("team");
  const [teamPanelView, setTeamPanelView] = useState<TeamPanelView>("goals");
  const [qMessages] = useState<ChatMessage[]>([]);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const globalQueueOrder = useMemo(() => {
    const autoIds = [...queue].sort((a, b) => a.position - b.position).map((item) => item.id);
    if (queueOrderMode === "auto") return autoIds;
    const known = manualQueueOrder.filter((id) => queue.some((item) => item.id === id));
    const knownSet = new Set(known);
    return [...known, ...autoIds.filter((id) => !knownSet.has(id))];
  }, [queue, queueOrderMode, manualQueueOrder]);

  const orderedQueue = useMemo(
    () => globalQueueOrder.map((id, index) => ({ ...queue.find((entry) => entry.id === id)!, position: index + 1 })),
    [globalQueueOrder, queue],
  );
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? agents[0];
  const addressable = routableAgents(agents);
  const dropdownAgent = queueTarget ? agents.find((agent) => agent.id === queueTarget) ?? null : null;
  const previewTargetAgent = dropdownAgent;

  function notify(nextNotice: string) {
    setNotice(nextNotice);
  }

  function resolveConflict() {
    setConflictResolved(true);
    dataSource.updateAgents((current) => current.map((agent) => agent.id === "proof" ? { ...agent, detail: "Reviewing Atlas output read-only; no overlapping edits", progress: 55 } : agent));
    notify("Scope resolved · Proof redirected to read-only review");
  }

  function answerAgent(agent: Agent) {
    const mention = `@${agent.name} `;
    requestAnimationFrame(() => {
      const node = composerRef.current;
      if (!node) return;
      if (!node.value.startsWith(mention)) node.value = mention + node.value.trimStart();
      node.focus();
      node.setSelectionRange(node.value.length, node.value.length);
    });
  }

  function enqueuePrompt(value: string) {
    const prompt = value.trim();
    if (!prompt || agents.length === 0) return;
    const explicit = resolveAgentMention(prompt, agents) ?? dropdownAgent;
    const routedByOpenMind = !explicit;
    const targetAgent = explicit ?? pickAgentForOpenMind(agents);

    if (targetAgent.status === "needs-input") {
      dataSource.updateAgents((current) => current.map((agent) => agent.id === targetAgent.id ? { ...agent, status: "writing", alert: undefined, detail: "Picking up the latest floor prompt" } : agent));
    }

    if (queueMergeMode === "auto") {
      const existing = queue.find((entry) => entry.agentId === targetAgent.id);
      if (existing) {
        const prompts = [...(existing.mergedFrom ?? [existing.prompt]), prompt];
        dataSource.replaceQueue(queue.map((entry) => entry.id === existing.id ? { ...entry, mergedFrom: prompts } : entry));
        if (composerRef.current) composerRef.current.value = "";
        notify(`Merged into ${targetAgent.name}'s queue · ${prompts.length} prompts`);
        return;
      }
    }

    const position = queue.reduce((max, item) => Math.max(max, item.position), 0) + 1;
    const item: QueueItem = {
      id: `q-${Date.now()}`,
      prompt,
      author: "You",
      authorTone: "you",
      agentId: targetAgent.id,
      agentName: targetAgent.name,
      agentColor: targetAgent.color,
      position,
      status: "queued",
      queuedAt: "just now",
      routedByOpenMind,
    };
    dataSource.replaceQueue([...queue, item]);
    if (routedByOpenMind) setSelectedAgentId(targetAgent.id);
    setQueueScope("mine");
    setCollapsedRails((current) => ({ ...current, queue: false }));
    if (composerRef.current) composerRef.current.value = "";
    notify(routedByOpenMind ? `OpenMind routed your prompt to ${targetAgent.name}` : `Queued for ${targetAgent.name}`);
  }

  function createAgent(draft: AgentDraft) {
    const agent = dataSource.addAgent(draft);
    setSelectedAgentId(agent.id);
    setAgentLayout("focus");
    notify(`${agent.name} joined the prototype floor`);
  }

  function sendTeamMessage(text: string, thread: ChatThread = "team") {
    const trimmed = text.trim();
    if (!trimmed) return;
    dataSource.sendMessage({
      id: `tc-${Date.now()}`,
      authorId: user.id,
      authorName: user.displayName,
      authorTone: "you",
      text: trimmed,
      time: "just now",
      dmWith: thread === "team" ? undefined : thread,
    });
    notify(thread === "team" ? "Message added to prototype team chat" : "Direct message added locally");
  }

  function movePanel(panel: PanelId, direction: -1 | 1) {
    setPanelOrder((current) => {
      const next = [...current];
      const index = next.indexOf(panel);
      const target = index + direction;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function mergeQueueNow() {
    const merged: QueueItem[] = [];
    for (const item of orderedQueue) {
      const last = merged[merged.length - 1];
      if (last && last.agentId === item.agentId) {
        merged[merged.length - 1] = { ...last, mergedFrom: [...(last.mergedFrom ?? [last.prompt]), ...(item.mergedFrom ?? [item.prompt])] };
      } else merged.push(item);
    }
    if (merged.length === orderedQueue.length) {
      notify("Nothing to merge · no adjacent prompts share an agent");
      return;
    }
    dataSource.replaceQueue(merged);
    notify(`Queue merged · ${orderedQueue.length - merged.length} prompts folded in`);
  }

  function dropPanel(target: PanelId) {
    setDragOverPanel(null);
    if (!draggedPanel || draggedPanel === target) return;
    setPanelOrder((current) => {
      const next = current.filter((id) => id !== draggedPanel);
      next.splice(next.indexOf(target), 0, draggedPanel);
      return next;
    });
    setDraggedPanel(null);
  }

  function dropQueueItem(targetId: string) {
    if (!draggedQueueItem || draggedQueueItem === targetId) {
      setDraggedQueueItem(null);
      return;
    }
    const next = globalQueueOrder.filter((id) => id !== draggedQueueItem);
    next.splice(next.indexOf(targetId), 0, draggedQueueItem);
    setManualQueueOrder(next);
    setDraggedQueueItem(null);
  }

  function toggleRail(rail: RailId) {
    setCollapsedRails((current) => ({ ...current, [rail]: !current[rail] }));
  }

  function startResize(left: PanelId, right: PanelId, event: ReactPointerEvent<HTMLDivElement>) {
    const rail: RailId | null = left !== "floor" ? left : right !== "floor" ? right : null;
    if (!rail || collapsedRails[rail]) return;
    const direction = rail === left ? 1 : -1;
    const startX = event.clientX;
    const startWidth = railWidths[rail];
    setResizing(true);
    const onMove = (moveEvent: PointerEvent) => {
      const next = startWidth + direction * (moveEvent.clientX - startX);
      setRailWidths((current) => ({ ...current, [rail]: Math.max(RAIL_MIN_WIDTH, Math.min(RAIL_MAX_WIDTH, next)) }));
    };
    const onUp = () => {
      setResizing(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function isCollapsed(panel: PanelId) {
    return panel !== "floor" && collapsedRails[panel] && expandedPanel !== panel;
  }

  function slotStyle(panel: PanelId): CSSProperties {
    if (expandedPanel === panel) return { flex: "1 1 100%" };
    if (panel === "floor") return { flex: "1 1 0" };
    return { flex: `0 1 ${isCollapsed(panel) ? RAIL_COLLAPSED_WIDTH : railWidths[panel]}px` };
  }

  function chromeFor(panel: PanelId, index: number): PanelChrome {
    return {
      id: panel,
      index,
      count: panelOrder.length,
      expanded: expandedPanel === panel,
      collapsible: panel !== "floor",
      collapsed: isCollapsed(panel),
      onMove: (direction) => movePanel(panel, direction),
      onExpand: () => setExpandedPanel(expandedPanel === panel ? null : panel),
      onCollapse: () => { if (panel !== "floor") toggleRail(panel); },
      onDragStart: () => setDraggedPanel(panel),
      onDragEnd: () => { setDraggedPanel(null); setDragOverPanel(null); },
    };
  }

  function renderPanel(panel: PanelId, chrome: PanelChrome) {
    if (panel === "brief") {
      return <BriefRail chrome={chrome} assignments={assignments} agents={agents} queue={queue} onAssignmentChange={dataSource.updateAssignment} onNotice={notify} view={teamPanelView} onViewChange={setTeamPanelView} messages={teamChat} onSendMessage={sendTeamMessage} chatThread={chatThread} onChatThreadChange={setChatThread} participants={participants} />;
    }
    if (panel === "queue") {
      return <PromptQueue chrome={chrome} items={orderedQueue} scope={queueScope} onScope={setQueueScope} orderMode={queueOrderMode} onOrderMode={setQueueOrderMode} mergeMode={queueMergeMode} onMergeMode={setQueueMergeMode} onMergeNow={mergeQueueNow} mergingIds={[]} draggedItemId={draggedQueueItem} onItemDragStart={setDraggedQueueItem} onItemDragEnd={() => setDraggedQueueItem(null)} onItemDrop={dropQueueItem} selectedAgentName={selectedAgent?.name ?? "an agent"} />;
    }
    return selectedAgent ? <AgentFloor chrome={chrome} agents={agents} selected={selectedAgent} onSelect={setSelectedAgentId} agentLayout={agentLayout} onAgentLayout={setAgentLayout} onCreateAgent={createAgent} onNotice={notify} onAnswer={answerAgent} qMessages={qMessages} participants={participants} currentUserName={user.displayName} /> : null;
  }

  return (
    <main className="app-shell" data-screen={screen}>
      <TopBar screen={screen} onScreen={setScreen} onNotice={notify} session={session} user={user} members={members} />
      <ObjectiveBar objective={session.objective} updatedAt={session.updatedAt} onSave={onSaveObjective} />

      {screen === "review" ? (
        <ReviewScreen agents={agents} conflictResolved={conflictResolved} onNotice={notify} onResolveConflict={resolveConflict} teamChat={teamChat} onSendTeamMessage={sendTeamMessage} participants={participants} />
      ) : (
        <>
          <div className="workspace" data-expanded={expandedPanel ? "true" : "false"} data-resizing={resizing ? "true" : "false"}>
            {panelOrder.map((panel, index) => {
              const next = panelOrder[index + 1];
              const showHandle = !expandedPanel && next !== undefined && !(isCollapsed(panel) && panel !== "floor");
              return (
                <div key={panel} className="panel-slot" style={slotStyle(panel)} data-expanded={expandedPanel === panel ? "true" : "false"} data-collapsed={isCollapsed(panel) ? "true" : "false"} data-dragging={draggedPanel === panel ? "true" : "false"} data-drop-target={dragOverPanel === panel ? "true" : "false"}
                  onDragOver={(event) => { event.preventDefault(); if (draggedPanel && draggedPanel !== panel) setDragOverPanel(panel); }}
                  onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOverPanel((current) => current === panel ? null : current); }}
                  onDrop={() => dropPanel(panel)}>
                  {renderPanel(panel, chromeFor(panel, index))}
                  {showHandle && <div className="resize-handle" role="separator" aria-label={`Resize ${panel} panel`} onPointerDown={(event) => startResize(panel, next, event)} />}
                </div>
              );
            })}
          </div>
          <FloorDock onSubmit={enqueuePrompt} onNotice={notify} agents={agents} checks={checks} conflictResolved={conflictResolved} onResolveConflict={resolveConflict} onOpenChecks={() => setScreen("review")} routableAgents={addressable} queueTarget={queueTarget} onQueueTargetChange={setQueueTarget} previewTargetAgent={previewTargetAgent} textareaRef={composerRef} onAnswer={answerAgent} notice={notice} user={user} />
        </>
      )}
      {screen === "review" && <StatusBar notice={notice} visible />}
    </main>
  );
}
