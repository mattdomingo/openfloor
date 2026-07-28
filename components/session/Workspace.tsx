"use client";

import { CSSProperties, FormEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  Agent,
  AgentDraft,
  AgentLayout,
  CenterMode,
  DockMode,
  PanelId,
  QueueItem,
  QueueOrderMode,
  QueueScope,
  RailId,
  TeamChatMessage,
  TeamPanelView,
  WorkspaceScreen,
  agentFromDraft,
  checks,
  defaultGoal,
  drafts,
  initialAgents,
  initialAssignments,
  initialQueue,
  initialTeamChat,
  pickAgentForOpenMind,
  resolveAgentMention,
  routableAgents,
  spawnQSubAgent,
} from "./data";
import { Icon } from "./primitives";
import { PanelChrome } from "./Rail";
import { TopBar } from "./TopBar";
import { ObjectiveBar } from "./ObjectiveBar";
import { BriefRail } from "./BriefRail";
import { AgentFloor } from "./AgentFloor";
import { PromptQueue } from "./PromptQueue";
import { ReviewScreen } from "./ReviewScreen";
import { FloorDock, FloorLane } from "./FloorDock";

const RAIL_COLLAPSED_WIDTH = 40;
const RAIL_MIN_WIDTH = 250;
const RAIL_MAX_WIDTH = 520;
const MAX_LIVE_LANES = 2;

export function Workspace({ sessionTitle }: { sessionTitle: string }) {
  const [screen, setScreen] = useState<WorkspaceScreen>("workspace");
  const [agents, setAgents] = useState(initialAgents);
  const [assignments, setAssignments] = useState(initialAssignments);
  const [queue, setQueue] = useState<QueueItem[]>(initialQueue);
  const [queueScope, setQueueScope] = useState<QueueScope>("team");
  const [queueOrderMode, setQueueOrderMode] = useState<QueueOrderMode>("auto");
  const [manualQueueOrder, setManualQueueOrder] = useState<string[]>([]);
  const [draggedQueueItem, setDraggedQueueItem] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState("atlas");
  const [conflictResolved, setConflictResolved] = useState(false);
  const [centerMode, setCenterMode] = useState<CenterMode>("activity");
  const [agentLayout, setAgentLayout] = useState<AgentLayout>("focus");
  const [panelOrder, setPanelOrder] = useState<PanelId[]>(["brief", "floor", "queue"]);
  const [railWidths, setRailWidths] = useState<Record<RailId, number>>({ brief: 340, queue: 326 });
  const [collapsedRails, setCollapsedRails] = useState<Record<RailId, boolean>>({ brief: false, queue: false });
  const [expandedPanel, setExpandedPanel] = useState<PanelId | null>(null);
  const [draggedPanel, setDraggedPanel] = useState<PanelId | null>(null);
  const [sessionGoal, setSessionGoal] = useState(defaultGoal);
  const [message, setMessage] = useState("");
  const [dockMode, setDockMode] = useState<DockMode>("live");
  const [draftTicks, setDraftTicks] = useState([18, -70, -150]);
  const [notice, setNotice] = useState("Ali joined · caught up from session state");
  const [toastVisible, setToastVisible] = useState(true);
  const [qBusy, setQBusy] = useState(false);
  const [qSubSequence, setQSubSequence] = useState(0);
  const [queueTarget, setQueueTarget] = useState<string | null>(null);
  const [teamChat, setTeamChat] = useState<TeamChatMessage[]>(initialTeamChat);
  const [teamPanelView, setTeamPanelView] = useState<TeamPanelView>("goals");
  const workspaceRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const globalQueueOrder = useMemo(() => {
    const autoIds = [...queue].sort((a, b) => a.position - b.position).map((item) => item.id);
    if (queueOrderMode === "auto") return autoIds;
    const known = manualQueueOrder.filter((id) => queue.some((item) => item.id === id));
    const knownSet = new Set(known);
    const rest = autoIds.filter((id) => !knownSet.has(id));
    return [...known, ...rest];
  }, [queue, queueOrderMode, manualQueueOrder]);

  const orderedQueue = useMemo(
    () =>
      globalQueueOrder.map((id, index) => {
        const item = queue.find((entry) => entry.id === id)!;
        return { ...item, position: index + 1 };
      }),
    [globalQueueOrder, queue],
  );

  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? agents[0];
  const addressable = routableAgents(agents);
  const mentionedAgent = resolveAgentMention(message, agents);
  const dropdownAgent = queueTarget ? (agents.find((agent) => agent.id === queueTarget) ?? null) : null;
  const previewTargetAgent = mentionedAgent ?? dropdownAgent;

  useEffect(() => {
    const timer = window.setInterval(() => {
      setDraftTicks((ticks) =>
        ticks.map((tick, index) => (tick > drafts[index].text.length + 40 ? -(45 + index * 30) : tick + 1)),
      );
    }, 130);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!toastVisible) return;
    const timer = window.setTimeout(() => setToastVisible(false), 4500);
    return () => window.clearTimeout(timer);
  }, [notice, toastVisible]);

  const typingState = useMemo(
    () =>
      drafts.map((draft, index) => {
        const tick = draftTicks[index];
        const typing = tick > 0 && tick < draft.text.length + 40;
        const visibleText = draft.text.slice(0, Math.max(0, Math.min(tick, draft.text.length)));
        return { ...draft, typing, visibleText };
      }),
    [draftTicks],
  );

  const typingIds = useMemo(
    () => new Set(typingState.filter((draft) => draft.typing).map((draft) => draft.id)),
    [typingState],
  );

  const lanes = useMemo<FloorLane[]>(() => {
    if (dockMode === "focus") return [];
    const toLane = ({ visibleText, typing, ...rest }: (typeof typingState)[number]): FloorLane => ({
      ...rest,
      typing,
      text: typing ? visibleText : "",
    });
    if (dockMode === "live") {
      return typingState.filter((draft) => draft.typing).slice(0, MAX_LIVE_LANES).map(toLane);
    }
    return typingState.map(toLane);
  }, [dockMode, typingState]);

  function notify(message: string) {
    setNotice(message);
    setToastVisible(true);
  }

  function resolveConflict() {
    setConflictResolved(true);
    setAgents((current) =>
      current.map((agent) =>
        agent.id === "proof"
          ? { ...agent, detail: "Reviewing Atlas output read-only; no overlapping edits", progress: 55 }
          : agent,
      ),
    );
    notify("Scope resolved · Proof redirected to read-only review");
  }

  function askQ(question: string) {
    if (!qBusy) {
      setQBusy(true);
      setAgents((current) =>
        current.map((agent) => (agent.id === "q" ? { ...agent, detail: `Answering: "${question}"` } : agent)),
      );
      notify("Q is answering your question");

      window.setTimeout(() => {
        setQBusy(false);
        setAgents((current) =>
          current.map((agent) => (agent.id === "q" ? { ...agent, detail: "Waiting for questions." } : agent)),
        );
      }, 6000);
      return;
    }

    const sequence = qSubSequence + 1;
    setQSubSequence(sequence);
    const subAgent = spawnQSubAgent(question, "You", sequence);
    setAgents((current) => [...current, subAgent]);
    notify(`Q is busy · spun up ${subAgent.name} for your question`);

    window.setTimeout(() => {
      setAgents((current) =>
        current.map((agent) =>
          agent.id === subAgent.id ? { ...agent, status: "complete", detail: "Answer ready, merging back into Q." } : agent,
        ),
      );

      window.setTimeout(() => {
        setAgents((current) => current.filter((agent) => agent.id !== subAgent.id));
        notify(`${subAgent.name} merged back into Q`);
      }, 2500);
    }, 6000);
  }

  /* Sends the user to the composer with the agent already mentioned, so answering a
     needs-input agent is one click from either the spotlight or the attention strip. */
  function answerAgent(agent: Agent) {
    const mention = `@${agent.name} `;
    setMessage((current) => (current.startsWith(mention) ? current : mention + current.trimStart()));

    requestAnimationFrame(() => {
      const node = composerRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(node.value.length, node.value.length);
    });
  }

  function enqueuePrompt(event: FormEvent) {
    event.preventDefault();
    const prompt = message.trim();
    if (!prompt) return;

    const mentioned = resolveAgentMention(prompt, agents);
    const explicit = mentioned ?? dropdownAgent;
    const routedByOpenMind = !explicit;
    const targetAgent = explicit ?? pickAgentForOpenMind(agents);

    /* Answering the agent is what it was waiting on, so it goes back to work. */
    if (targetAgent.status === "needs-input") {
      const answer = prompt.replace(`@${targetAgent.name}`, "").trim();
      const shortAnswer = answer.length > 60 ? `${answer.slice(0, 57)}…` : answer;
      setAgents((current) =>
        current.map((agent) =>
          agent.id === targetAgent.id
            ? { ...agent, status: "writing", alert: undefined, detail: `Picking up your answer: "${shortAnswer}"` }
            : agent,
        ),
      );
    }

    if (targetAgent.kind === "qa") {
      askQ(prompt);
      setMessage("");
      return;
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
    };

    setQueue((current) => [...current, item]);
    setQueueScope("mine");
    setCollapsedRails((current) => ({ ...current, queue: false }));
    setMessage("");
    notify(
      routedByOpenMind
        ? `OpenMind routed your prompt to ${targetAgent.name} · #${position}`
        : `Queued for ${targetAgent.name} · #${position}`,
    );
  }

  function createAgent(draft: AgentDraft) {
    const agent = agentFromDraft(draft, agents.length + 1);
    setAgents((current) => [...current, agent]);
    setSelectedAgentId(agent.id);
    setCenterMode("activity");
    setAgentLayout("focus");
    notify(`${agent.name} joined the floor · ${agent.branch}`);
  }

  function updateAssignment(id: string, task: string) {
    setAssignments((current) => current.map((assignment) => (assignment.id === id ? { ...assignment, task } : assignment)));
  }

  function sendTeamMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;

    setTeamChat((current) => [
      ...current,
      { id: `tc-${Date.now()}`, authorId: "you", authorName: "You", authorTone: "you", text: trimmed, time: "just now" },
    ]);
  }

  function openReview() {
    setScreen("review");
    notify("Opened candidate branch review");
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

  function dropPanel(target: PanelId) {
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
    const targetIndex = next.indexOf(targetId);
    next.splice(targetIndex, 0, draggedQueueItem);
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

    const onMove = (moveEvent: PointerEvent) => {
      const next = startWidth + direction * (moveEvent.clientX - startX);
      setRailWidths((current) => ({ ...current, [rail]: Math.max(RAIL_MIN_WIDTH, Math.min(RAIL_MAX_WIDTH, next)) }));
    };
    const onUp = () => {
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
      onCollapse: () => {
        if (panel !== "floor") toggleRail(panel);
      },
      onDragStart: () => setDraggedPanel(panel),
      onDragEnd: () => setDraggedPanel(null),
    };
  }

  function renderPanel(panel: PanelId, chrome: PanelChrome) {
    if (panel === "brief") {
      return (
        <BriefRail
          chrome={chrome}
          assignments={assignments}
          agents={agents}
          queue={queue}
          onAssignmentChange={updateAssignment}
          onNotice={notify}
          view={teamPanelView}
          onViewChange={setTeamPanelView}
          messages={teamChat}
          onSendMessage={sendTeamMessage}
        />
      );
    }
    if (panel === "queue") {
      return (
        <PromptQueue
          chrome={chrome}
          items={orderedQueue}
          scope={queueScope}
          onScope={setQueueScope}
          orderMode={queueOrderMode}
          onOrderMode={setQueueOrderMode}
          draggedItemId={draggedQueueItem}
          onItemDragStart={setDraggedQueueItem}
          onItemDragEnd={() => setDraggedQueueItem(null)}
          onItemDrop={dropQueueItem}
          selectedAgentName={selectedAgent.name}
        />
      );
    }
    return (
      <AgentFloor
        chrome={chrome}
        agents={agents}
        selected={selectedAgent}
        onSelect={setSelectedAgentId}
        centerMode={centerMode}
        onCenterMode={setCenterMode}
        agentLayout={agentLayout}
        onAgentLayout={setAgentLayout}
        onCreateAgent={createAgent}
        onNotice={notify}
        onAnswer={answerAgent}
      />
    );
  }

  return (
    <main className="app-shell" data-screen={screen}>
      <TopBar screen={screen} onScreen={setScreen} onNotice={notify} sessionTitle={sessionTitle} />

      <ObjectiveBar goal={sessionGoal} onGoalChange={setSessionGoal} onNotice={notify} />

      {screen === "review" ? (
        <ReviewScreen
          agents={agents}
          conflictResolved={conflictResolved}
          onNotice={notify}
          onResolveConflict={resolveConflict}
          teamChat={teamChat}
          onSendTeamMessage={sendTeamMessage}
        />
      ) : (
        <>
          <div className="workspace" data-expanded={expandedPanel ? "true" : "false"} ref={workspaceRef}>
            {panelOrder.map((panel, index) => {
              const next = panelOrder[index + 1];
              const showHandle = !expandedPanel && next !== undefined && !(isCollapsed(panel) && panel !== "floor");
              return (
                <div
                  key={panel}
                  className="panel-slot"
                  style={slotStyle(panel)}
                  data-expanded={expandedPanel === panel ? "true" : "false"}
                  data-collapsed={isCollapsed(panel) ? "true" : "false"}
                  data-dragging={draggedPanel === panel ? "true" : "false"}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => dropPanel(panel)}
                >
                  {renderPanel(panel, chromeFor(panel, index))}
                  {showHandle && (
                    <div
                      className="resize-handle"
                      role="separator"
                      aria-label={`Resize ${panel} panel`}
                      onPointerDown={(event) => startResize(panel, next, event)}
                    />
                  )}
                </div>
              );
            })}
          </div>

          <FloorDock
            value={message}
            onChange={setMessage}
            onSubmit={enqueuePrompt}
            onNotice={notify}
            dockMode={dockMode}
            onDockModeChange={setDockMode}
            lanes={lanes}
            typingIds={typingIds}
            agents={agents}
            checks={checks}
            conflictResolved={conflictResolved}
            onResolveConflict={resolveConflict}
            onOpenChecks={openReview}
            routableAgents={addressable}
            queueTarget={queueTarget}
            onQueueTargetChange={setQueueTarget}
            previewTargetAgent={previewTargetAgent}
            textareaRef={composerRef}
            onAnswer={answerAgent}
          />
        </>
      )}

      <div className="toast" role="status" data-visible={toastVisible ? "true" : "false"}>
        <Icon name="circle" size={7} />
        {notice}
      </div>
    </main>
  );
}
