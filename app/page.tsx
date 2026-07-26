"use client";

import { CSSProperties, FormEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  AgentLayout,
  CenterMode,
  DockMode,
  PanelId,
  RailId,
  checks,
  defaultGoal,
  drafts,
  initialAgents,
  initialAssignments,
} from "@/components/session/data";
import { Icon } from "@/components/session/primitives";
import { PanelChrome } from "@/components/session/Rail";
import { TopBar } from "@/components/session/TopBar";
import { ObjectiveBar } from "@/components/session/ObjectiveBar";
import { AttentionStrip } from "@/components/session/AttentionStrip";
import { BriefRail } from "@/components/session/BriefRail";
import { AgentFloor } from "@/components/session/AgentFloor";
import { RepositoryRail } from "@/components/session/RepositoryRail";
import { FloorDock, FloorLane } from "@/components/session/FloorDock";

const RAIL_COLLAPSED_WIDTH = 40;
const RAIL_MIN_WIDTH = 250;
const RAIL_MAX_WIDTH = 520;
const MAX_LIVE_LANES = 2;

export default function Home() {
  const [agents, setAgents] = useState(initialAgents);
  const [assignments, setAssignments] = useState(initialAssignments);
  const [selectedAgentId, setSelectedAgentId] = useState("atlas");
  const [conflictResolved, setConflictResolved] = useState(false);
  const [centerMode, setCenterMode] = useState<CenterMode>("activity");
  const [agentLayout, setAgentLayout] = useState<AgentLayout>("focus");
  const [repoTab, setRepoTab] = useState<"changes" | "checks">("changes");
  const [fileFilter, setFileFilter] = useState<"all" | "attention">("all");
  const [panelOrder, setPanelOrder] = useState<PanelId[]>(["brief", "floor", "repository"]);
  const [railWidths, setRailWidths] = useState<Record<RailId, number>>({ brief: 306, repository: 326 });
  const [collapsedRails, setCollapsedRails] = useState<Record<RailId, boolean>>({ brief: false, repository: false });
  const [expandedPanel, setExpandedPanel] = useState<PanelId | null>(null);
  const [draggedPanel, setDraggedPanel] = useState<PanelId | null>(null);
  const [sessionGoal, setSessionGoal] = useState(defaultGoal);
  const [message, setMessage] = useState("");
  const [dockMode, setDockMode] = useState<DockMode>("live");
  const [draftTicks, setDraftTicks] = useState([18, -70, -150]);
  const [notice, setNotice] = useState("Ali joined · caught up from session state");
  const [toastVisible, setToastVisible] = useState(true);
  const workspaceRef = useRef<HTMLDivElement>(null);

  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? agents[0];

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

  function submitTask(event: FormEvent) {
    event.preventDefault();
    const task = message.trim();
    if (!task) return;
    const id = `worker-${agents.length + 1}`;
    setAgents((current) => [
      ...current,
      {
        id,
        name: "Orbit",
        role: "Worker",
        task,
        owner: "You",
        color: "#8b6bb1",
        status: "running",
        progress: 9,
        detail: "Reading task contract and preparing an isolated worktree",
        files: ["Scope not claimed yet"],
        branch: "of/orbit-new-task",
        time: "now",
      },
    ]);
    setSelectedAgentId(id);
    setAgentLayout("focus");
    setMessage("");
    notify(`Task dispatched · Orbit is planning “${task}”`);
  }

  function updateAssignment(id: string, task: string) {
    setAssignments((current) => current.map((assignment) => (assignment.id === id ? { ...assignment, task } : assignment)));
  }

  function changeCenterMode(mode: CenterMode) {
    setCenterMode(mode);
    if (mode === "codebase") setAgentLayout("focus");
  }

  function openChecks() {
    setRepoTab("checks");
    setCollapsedRails((current) => ({ ...current, repository: false }));
    notify("Showing deterministic checks for the candidate branch");
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
      return <BriefRail chrome={chrome} assignments={assignments} onAssignmentChange={updateAssignment} onNotice={notify} />;
    }
    if (panel === "repository") {
      return (
        <RepositoryRail
          chrome={chrome}
          tab={repoTab}
          onTab={setRepoTab}
          filter={fileFilter}
          onFilter={setFileFilter}
          onNotice={notify}
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
        onCenterMode={changeCenterMode}
        agentLayout={agentLayout}
        onAgentLayout={setAgentLayout}
        onNotice={notify}
      />
    );
  }

  return (
    <main className="app-shell">
      <TopBar onNotice={notify} />

      <ObjectiveBar goal={sessionGoal} onGoalChange={setSessionGoal} onNotice={notify} />

      <AttentionStrip
        agents={agents}
        checks={checks}
        conflictResolved={conflictResolved}
        onResolveConflict={resolveConflict}
        onOpenChecks={openChecks}
        onNotice={notify}
      />

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
        onSubmit={submitTask}
        onNotice={notify}
        dockMode={dockMode}
        onDockModeChange={setDockMode}
        lanes={lanes}
        typingIds={typingIds}
      />

      <div className="toast" role="status" data-visible={toastVisible ? "true" : "false"}>
        <Icon name="circle" size={7} />
        {notice}
      </div>
    </main>
  );
}
