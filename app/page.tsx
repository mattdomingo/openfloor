"use client";

import { FormEvent, PointerEvent as ReactPointerEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";

type AgentStatus = "running" | "reviewing" | "blocked" | "complete";
type PanelId = "tasks" | "agents" | "repository";
type CenterMode = "activity" | "codebase";
type AgentLayout = "focus" | "all";
type ComposerView = "you" | "matt" | "ryan" | "ali" | "all";

type Agent = {
  id: string;
  name: string;
  role: string;
  task: string;
  owner: string;
  color: string;
  status: AgentStatus;
  progress: number;
  detail: string;
  files: string[];
  branch: string;
  time: string;
};

const initialAgents: Agent[] = [
  {
    id: "atlas",
    name: "Atlas",
    role: "Backend worker",
    task: "Session event protocol",
    owner: "Matt",
    color: "#ee6c4d",
    status: "running",
    progress: 72,
    detail: "Normalizing task and agent lifecycle events",
    files: ["server/events/schema.ts", "server/session/reducer.ts"],
    branch: "of/atlas-session-events",
    time: "12m",
  },
  {
    id: "nova",
    name: "Nova",
    role: "Frontend worker",
    task: "Agent activity cards",
    owner: "Ryan",
    color: "#d4a72c",
    status: "running",
    progress: 58,
    detail: "Wiring live status transitions to the session view",
    files: ["app/session/AgentCard.tsx", "app/session/activity.css"],
    branch: "of/nova-agent-cards",
    time: "8m",
  },
  {
    id: "sentry",
    name: "Sentry",
    role: "Test worker",
    task: "Event reducer coverage",
    owner: "Matt",
    color: "#5b8e7d",
    status: "blocked",
    progress: 34,
    detail: "Waiting on event payload shape from Atlas",
    files: ["tests/session-reducer.test.ts"],
    branch: "of/sentry-reducer-tests",
    time: "6m",
  },
  {
    id: "proof",
    name: "Proof",
    role: "Reviewer",
    task: "Integrated change review",
    owner: "Ali",
    color: "#577590",
    status: "reviewing",
    progress: 41,
    detail: "Checking task boundaries and combined type safety",
    files: ["server/session/reducer.ts", "app/session/AgentCard.tsx"],
    branch: "of/proof-integrated-review",
    time: "4m",
  },
];

const initialAssignments = [
  { id: "matt", name: "Matt", initials: "M", color: "coral", agent: "Atlas · Backend", task: "Define the session event protocol and reconnect replay contract.", state: "Active", tone: "orange" },
  { id: "ryan", name: "Ryan", initials: "R", color: "yellow", agent: "Nova · Frontend", task: "Build agent activity cards and wire live status transitions.", state: "Active", tone: "yellow" },
  { id: "ali", name: "Ali", initials: "A", color: "green", agent: "Proof · Reviewer", task: "Review integrated changes and resolve status naming inconsistencies.", state: "Review", tone: "blue" },
];

const fileRows = [
  { path: "server/events/schema.ts", agent: "Atlas", add: 84, del: 6, state: "modified" },
  { path: "server/session/reducer.ts", agent: "Atlas · Proof", add: 126, del: 18, state: "attention" },
  { path: "app/session/AgentCard.tsx", agent: "Nova · Proof", add: 192, del: 12, state: "modified" },
  { path: "app/session/activity.css", agent: "Nova", add: 77, del: 4, state: "modified" },
  { path: "tests/session-reducer.test.ts", agent: "Sentry", add: 63, del: 0, state: "pending" },
];

const liveScripts = [
  { name: "Matt", color: "coral", text: "Atlas, keep the event envelope backwards compatible with reconnect replay." },
  { name: "Ryan", color: "yellow", text: "Nova, add the blocked state before you prepare the frontend patch." },
  { name: "Ali", color: "green", text: "I’m checking whether the reducer and card agree on status naming…" },
];

const codeByAgent: Record<string, { path: string; lines: string[] }> = {
  atlas: {
    path: "server/events/schema.ts",
    lines: [
      "export type SessionEvent<T extends EventType> = {",
      "  eventId: string;",
      "  sessionId: string;",
      "  sequence: number;",
      "  occurredAt: string;",
      "  actor: EventActor;",
      "  type: T;",
      "  payload: EventPayloadMap[T];",
      "  causationId?: string;",
      "};",
      "",
      "export function reduceSession(state, event) {",
      "  return reducers[event.type](state, event.payload);",
      "}",
    ],
  },
  nova: {
    path: "app/session/AgentCard.tsx",
    lines: [
      "export function AgentCard({ agent, onFocus }) {",
      "  return (",
      "    <article data-status={agent.status}>",
      "      <AgentIdentity agent={agent} />",
      "      <Progress value={agent.progress} />",
      "      <CurrentStep>{agent.currentStep}</CurrentStep>",
      "      <OwnedFiles files={agent.ownedPaths} />",
      "      <button onClick={onFocus}>Open worktree</button>",
      "    </article>",
      "  );",
      "}",
    ],
  },
  sentry: {
    path: "tests/session-reducer.test.ts",
    lines: [
      "describe(\"session event reducer\", () => {",
      "  it(\"replays events in sequence order\", () => {",
      "    const session = replay(fixture.events);",
      "",
      "    expect(session.tasks.active).toHaveLength(2);",
      "    expect(session.agents.sentry.status).toBe(\"blocked\");",
      "    expect(session.lastSequence).toBe(42);",
      "  });",
      "});",
    ],
  },
  proof: {
    path: "server/session/reducer.ts",
    lines: [
      "case \"agent.status_changed\": {",
      "  const agent = state.agents[event.payload.agentId];",
      "",
      "  return updateAgent(state, agent.id, {",
      "    status: event.payload.status,",
      "    currentStep: event.payload.currentStep,",
      "    updatedAt: event.occurredAt,",
      "  });",
      "}",
    ],
  },
};

function StatusDot({ status }: { status: AgentStatus }) {
  return <span className={`status-dot ${status}`} aria-hidden="true" />;
}

function SegmentedControl({ options, value, onChange, label }: { options: { value: string; label: string }[]; value: string; onChange: (value: string) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} className={value === option.value ? "active" : ""} onClick={() => onChange(option.value)}>{option.label}</button>
      ))}
    </div>
  );
}

function PanelControls({ panel, order, expanded, onExpand, onMove }: { panel: PanelId; order: PanelId[]; expanded: boolean; onExpand: () => void; onMove: (direction: -1 | 1) => void }) {
  const index = order.indexOf(panel);
  return (
    <div className="panel-controls">
      <button className="drag-handle" title="Drag to move panel" aria-label={`Move ${panel} panel`}>⠿</button>
      <button onClick={() => onMove(-1)} disabled={index === 0} title="Move panel left" aria-label={`Move ${panel} panel left`}>←</button>
      <button onClick={() => onMove(1)} disabled={index === order.length - 1} title="Move panel right" aria-label={`Move ${panel} panel right`}>→</button>
      <button onClick={onExpand} title={expanded ? "Restore panel" : "Expand panel"} aria-label={expanded ? `Restore ${panel} panel` : `Expand ${panel} panel`}>{expanded ? "↙" : "↗"}</button>
    </div>
  );
}

export default function Home() {
  const [agents, setAgents] = useState(initialAgents);
  const [selectedAgent, setSelectedAgent] = useState("atlas");
  const [conflictResolved, setConflictResolved] = useState(false);
  const [repoTab, setRepoTab] = useState<"changes" | "checks">("changes");
  const [fileFilter, setFileFilter] = useState<"all" | "attention">("all");
  const [centerMode, setCenterMode] = useState<CenterMode>("activity");
  const [agentLayout, setAgentLayout] = useState<AgentLayout>("focus");
  const [panelOrder, setPanelOrder] = useState<PanelId[]>(["tasks", "agents", "repository"]);
  const [panelWidths, setPanelWidths] = useState<Record<PanelId, number>>({ tasks: 23, agents: 51, repository: 26 });
  const [expandedPanel, setExpandedPanel] = useState<PanelId | null>(null);
  const [draggedPanel, setDraggedPanel] = useState<PanelId | null>(null);
  const [draftSteps, setDraftSteps] = useState([22, 17, 12]);
  const [composerView, setComposerView] = useState<ComposerView>("you");
  const [sessionGoal, setSessionGoal] = useState("Ship realtime presence and agent activity with a shared event model, isolated agent worktrees, and a reviewable combined repository state.");
  const [assignments, setAssignments] = useState(initialAssignments);
  const [dispatch, setDispatch] = useState("");
  const [notice, setNotice] = useState("Ali joined · caught up from session state");
  const workspaceRef = useRef<HTMLDivElement>(null);

  const selected = agents.find((agent) => agent.id === selectedAgent) ?? agents[0];
  const selectedCode = codeByAgent[selected.id] ?? codeByAgent.atlas;
  const visibleFiles = useMemo(
    () => fileRows.filter((file) => fileFilter === "all" || file.state === "attention"),
    [fileFilter],
  );

  useEffect(() => {
    const timer = window.setInterval(() => {
      setDraftSteps((steps) => steps.map((step, index) => (step >= liveScripts[index].text.length + 12 ? 0 : step + 1)));
    }, 145);
    return () => window.clearInterval(timer);
  }, []);

  function resolveConflict() {
    setConflictResolved(true);
    setAgents((current) => current.map((agent) => agent.id === "proof" ? { ...agent, detail: "Reviewing Atlas output read-only; no overlapping edits", progress: 55 } : agent));
    setNotice("Scope resolved · Proof redirected to read-only review");
  }

  function submitTask(event: FormEvent) {
    event.preventDefault();
    const task = dispatch.trim();
    if (!task) return;
    const id = `worker-${agents.length + 1}`;
    setAgents((current) => [...current, { id, name: "Orbit", role: "Worker", task, owner: "You", color: "#8b6bb1", status: "running", progress: 9, detail: "Reading task contract and preparing an isolated worktree", files: ["Scope not claimed yet"], branch: "of/orbit-new-task", time: "now" }]);
    setSelectedAgent(id);
    setAgentLayout("focus");
    setDispatch("");
    setNotice(`Task dispatched · Orbit is planning “${task}”`);
  }

  function updateAssignment(id: string, task: string) {
    setAssignments((current) => current.map((assignment) => assignment.id === id ? { ...assignment, task } : assignment));
  }

  function changeCenterMode(value: string) {
    const mode = value as CenterMode;
    setCenterMode(mode);
    if (mode === "codebase") setAgentLayout("focus");
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

  function startResize(left: PanelId, right: PanelId, event: ReactPointerEvent<HTMLDivElement>) {
    const workspaceWidth = workspaceRef.current?.getBoundingClientRect().width ?? 1;
    const startX = event.clientX;
    const startLeft = panelWidths[left];
    const startRight = panelWidths[right];
    const onMove = (moveEvent: PointerEvent) => {
      const delta = ((moveEvent.clientX - startX) / workspaceWidth) * 100;
      const nextLeft = Math.max(18, Math.min(startLeft + delta, startLeft + startRight - 18));
      const nextRight = startLeft + startRight - nextLeft;
      setPanelWidths((current) => ({ ...current, [left]: nextLeft, [right]: nextRight }));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function panelHeader(panel: PanelId, eyebrow: string, title: string, extra?: ReactNode) {
    const expanded = expandedPanel === panel;
    return (
      <div className="panel-heading" draggable onDragStart={() => setDraggedPanel(panel)} onDragEnd={() => setDraggedPanel(null)}>
        <div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div>
        <div className="panel-heading-actions">{extra}<PanelControls panel={panel} order={panelOrder} expanded={expanded} onExpand={() => setExpandedPanel(expanded ? null : panel)} onMove={(direction) => movePanel(panel, direction)} /></div>
      </div>
    );
  }

  function agentCard(agent: Agent, full = false) {
    return (
      <article key={agent.id} className={`agent-card ${full ? "full" : ""} ${agentLayout === "focus" && selectedAgent === agent.id ? "selected" : ""}`} style={{ "--agent-color": agent.color } as React.CSSProperties}>
        <div className="agent-topline">
          <span className="agent-glyph">{agent.name.slice(0, 1)}</span>
          <span className="agent-name"><strong>{agent.name}</strong><small>{agent.role}</small></span>
          <span className="agent-status"><StatusDot status={agent.status} />{agent.status}</span>
        </div>
        <div className="agent-task"><span>{agent.task}</span><strong>{agent.progress}%</strong></div>
        <div className="progress-track"><i style={{ width: `${agent.progress}%` }} /></div>
        <p>{agent.detail}</p>
        <div className="agent-files"><span>⌘</span><span>{agent.files[0]}</span>{agent.files.length > 1 && <b>+{agent.files.length - 1}</b>}</div>
        {full && <div className="mini-plan"><span className="done">✓ Contract</span><span className="done">✓ Scope</span><span className="active">● Implementing</span><span>○ Checks</span></div>}
        <div className="agent-footer"><span>Launched by {agent.owner}</span><span>{agent.time}</span></div>
      </article>
    );
  }

  function tasksPanel() {
    return (
      <aside className="tasks-panel panel">
        {panelHeader("tasks", "SESSION BRIEF", "Goal & ownership")}
        <div className="session-brief">
          <label className="goal-editor">
            <span><span className="eyebrow">OVERALL GOAL</span><em>Editable by everyone</em></span>
            <textarea value={sessionGoal} onChange={(event) => setSessionGoal(event.target.value)} onBlur={() => setNotice("Session goal updated for everyone")} aria-label="Editable session goal" />
          </label>
          <div className="assignment-heading"><span className="eyebrow">ENGINEER OWNERSHIP</span><span>{assignments.length} people</span></div>
          <div className="assignment-list">
            {assignments.map((assignment) => (
              <label className="assignment-card" key={assignment.id}>
                <span className={`avatar ${assignment.color}`}>{assignment.initials}</span>
                <span className="assignment-copy">
                  <span><strong>{assignment.name}</strong><em>{assignment.agent}</em></span>
                  <textarea value={assignment.task} onChange={(event) => updateAssignment(assignment.id, event.target.value)} onBlur={() => setNotice(`${assignment.name}’s assignment updated for everyone`)} aria-label={`Edit ${assignment.name}'s assignment`} />
                </span>
                <span className={`state-tag ${assignment.tone}`}>{assignment.state}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="decision-card"><span className="eyebrow">LATEST DECISION</span><strong>WebSocket reconnects replay from the last acknowledged event.</strong><span>Decided by Matt · 8m ago</span></div>
      </aside>
    );
  }

  function agentsPanel() {
    const centerControls = (
      <div className="center-controls">
        <SegmentedControl label="Agent view" value={centerMode} onChange={changeCenterMode} options={[{ value: "activity", label: "Activity" }, { value: "codebase", label: "Codebase" }]} />
        {centerMode === "activity" && <SegmentedControl label="Agent layout" value={agentLayout} onChange={(value) => setAgentLayout(value as AgentLayout)} options={[{ value: "focus", label: "Focused" }, { value: "all", label: "All agents" }]} />}
      </div>
    );
    return (
      <section className="agents-panel panel">
        {panelHeader("agents", "ACTIVE FLOOR", `${agents.filter((agent) => agent.status !== "complete").length} agents working`, centerControls)}
        {(centerMode === "codebase" || (centerMode === "activity" && agentLayout === "focus")) && (
          <div className="agent-picker" aria-label="Select an agent">
            {agents.map((agent) => <button key={agent.id} className={selected.id === agent.id ? "active" : ""} onClick={() => setSelectedAgent(agent.id)}><StatusDot status={agent.status} />{agent.name}</button>)}
          </div>
        )}

        {centerMode === "activity" ? (
          <>
            {!conflictResolved ? (
              <div className="conflict-banner"><div className="conflict-icon">!</div><div><span className="eyebrow">PLANNED SCOPE CONFLICT</span><strong>Atlas and Proof both claim <code>server/session/reducer.ts</code></strong><p>The orchestrator recommends keeping Atlas as owner and making Proof’s pass read-only.</p></div><button onClick={resolveConflict}>Apply resolution</button></div>
            ) : (
              <div className="resolved-banner"><span>✓</span><strong>Scope resolved</strong><p>Atlas owns the reducer. Proof will review its patch read-only.</p></div>
            )}
            {agentLayout === "all" ? (
              <div className="agent-grid-all" aria-label="All active agents">{agents.map((agent) => agentCard(agent, true))}</div>
            ) : (
              <div className="focused-agent-stage">
                {agentCard(selected, true)}
                <div className="agent-detail">
                  <div className="detail-header"><div className="agent-glyph large" style={{ background: selected.color }}>{selected.name.slice(0, 1)}</div><div><span className="eyebrow">CURRENT PLAN</span><h3>{selected.name} · {selected.task}</h3><p>{selected.branch}</p></div><button className="small-button" onClick={() => setNotice(`${selected.name} has been asked for a status update`)}>Ask for update</button></div>
                  <div className="detail-steps"><span className="done"><i>✓</i>Read contract</span><span className="done"><i>✓</i>Claim scope</span><span className="active"><i>3</i>Implement</span><span><i>4</i>Run checks</span><span><i>5</i>Prepare patch</span></div>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="code-workbench">
            <div className="code-layout">
              <aside className="file-explorer">
                <div className="explorer-title"><span>WORKTREE</span><b>{selected.name}</b></div>
                <div className="branch-row">⑂ {selected.branch}</div>
                <div className="tree-row folder">⌄ app</div>
                <div className="tree-row nested folder">⌄ session</div>
                {selected.files.filter((file) => file.startsWith("app/")).map((file) => <button className="tree-row file selected" key={file}>TS {file.split("/").pop()}</button>)}
                <div className="tree-row folder">⌄ server</div>
                {selected.files.filter((file) => file.startsWith("server/")).map((file) => <button className="tree-row file selected" key={file}>TS {file.split("/").pop()}</button>)}
                <div className="tree-row folder">⌄ tests</div>
                {selected.files.filter((file) => file.startsWith("tests/")).map((file) => <button className="tree-row file selected" key={file}>TS {file.split("/").pop()}</button>)}
                <div className="tree-row folder">› package.json</div>
                <div className="tree-row folder">› README.md</div>
                <div className="scope-note"><span className="eyebrow">WRITE SCOPE</span>{selected.files.map((file) => <code key={file}>{file}</code>)}</div>
              </aside>
              <section className="editor-pane">
                <div className="editor-tabs"><span className="active"><i>TS</i>{selectedCode.path.split("/").pop()} <b>×</b></span><span>Changes <em>{selected.files.length}</em></span></div>
                <div className="editor-breadcrumb">{selectedCode.path.split("/").join("  ›  ")}</div>
                <pre className="code-editor" aria-label={`${selected.name} codebase file ${selectedCode.path}`}>{selectedCode.lines.map((line, index) => <span className="code-line" key={`${line}-${index}`}><i>{index + 1}</i><code>{line || " "}</code></span>)}</pre>
                <div className="editor-status"><span>⑂ {selected.branch}</span><span>UTF-8&nbsp;&nbsp; TypeScript&nbsp;&nbsp; Ln 12, Col 18</span></div>
              </section>
            </div>
          </div>
        )}
      </section>
    );
  }

  function repositoryPanel() {
    return (
      <aside className="repo-panel panel">
        {panelHeader("repository", "COMBINED STATE", "Candidate branch", <span className="sync-state"><i /> Synced</span>)}
        <div className="repo-summary"><div><strong>5</strong><span>files changed</span></div><div><strong className="add">+542</strong><span>additions</span></div><div><strong className="del">−40</strong><span>deletions</span></div></div>
        <div className="tabs" role="tablist"><button className={repoTab === "changes" ? "active" : ""} onClick={() => setRepoTab("changes")}>Changes</button><button className={repoTab === "checks" ? "active" : ""} onClick={() => setRepoTab("checks")}>Checks <span>3/4</span></button></div>
        {repoTab === "changes" ? (
          <><div className="file-filter"><button className={fileFilter === "all" ? "active" : ""} onClick={() => setFileFilter("all")}>All files</button><button className={fileFilter === "attention" ? "active" : ""} onClick={() => setFileFilter("attention")}>Needs attention</button></div><div className="file-list">{visibleFiles.map((file) => <button className="file-row" key={file.path} onClick={() => setNotice(`Opening combined diff for ${file.path}`)}><span className={`file-state ${file.state}`}>{file.state === "attention" ? "!" : file.state === "pending" ? "◷" : "M"}</span><span className="file-copy"><strong>{file.path.split("/").pop()}</strong><small>{file.path.split("/").slice(0, -1).join("/")} · {file.agent}</small></span><span className="diff-stat"><i className="add">+{file.add}</i><i className="del">−{file.del}</i></span></button>)}</div></>
        ) : (
          <div className="checks-list"><div><span className="check-pass">✓</span><p><strong>Type check</strong><small>Passed · 32s</small></p></div><div><span className="check-pass">✓</span><p><strong>Unit tests</strong><small>48 passed · 1m 14s</small></p></div><div><span className="check-pass">✓</span><p><strong>Lint</strong><small>No warnings · 18s</small></p></div><div><span className="check-wait">◷</span><p><strong>Integration suite</strong><small>Waiting on OF-19</small></p></div></div>
        )}
        <div className="integration-card"><div><span className="eyebrow">INTEGRATION ORDER</span><b>1</b> Atlas <span>→</span> <b>2</b> Nova <span>→</span> <b>3</b> Sentry</div><button onClick={() => setNotice("Combined diff ready for review")}>Review combined diff <span>↗</span></button></div>
      </aside>
    );
  }

  function userComposer(compact = false) {
    return (
      <form className={`participant-compose you-compose ${compact ? "compact" : ""}`} onSubmit={submitTask}>
        <div className="compose-identity"><span className="avatar you">Y</span><span><strong>You</strong><small>Main session input</small></span><em>ready</em></div>
        <textarea value={dispatch} onChange={(event) => setDispatch(event.target.value)} placeholder="Dispatch a task, reply to a teammate, or steer the session…" aria-label="Your session message" />
        <div className="compose-actions"><button type="button" onClick={() => setNotice("Attach repository context")}>⌘ Attach context</button><span>Session context on</span><button type="submit" className="send-button" aria-label="Send your session message">↑</button></div>
      </form>
    );
  }

  function teammateComposer(draft: typeof liveScripts[number], index: number) {
    const visibleText = draft.text.slice(0, Math.min(draftSteps[index], draft.text.length));
    return (
      <label className="participant-compose teammate-compose" key={draft.name}>
        <span className="compose-identity"><i className={`avatar ${draft.color}`}>{draft.name.slice(0, 1)}</i><span><strong>{draft.name}</strong><small>Live draft</small></span><em><u /> typing</em></span>
        <textarea value={visibleText} readOnly aria-label={`${draft.name} live draft`} />
        <span className="watching-note">Visible only while {draft.name} is composing</span>
      </label>
    );
  }

  const panels: Record<PanelId, () => ReactNode> = { tasks: tasksPanel, agents: agentsPanel, repository: repositoryPanel };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup"><div className="brand-mark" aria-hidden="true"><span /><span /><span /></div><strong>OPENFLOOR</strong></div>
        <div className="session-path"><span>Sessions</span><b>/</b><strong>Realtime presence</strong><span className="live-pill"><i /> LIVE</span></div>
        <div className="top-actions"><div className="participants" aria-label="Participants: Matt, Ryan, and Ali"><span className="avatar coral">M</span><span className="avatar yellow">R</span><span className="avatar green">A</span></div><button className="invite-button" onClick={() => setNotice("Invite link copied to clipboard")}>+ Invite</button><button className="icon-button" aria-label="Session menu">•••</button></div>
      </header>

      <section className="objective-bar"><div><span className="eyebrow">SESSION OBJECTIVE</span><h1>Ship realtime presence and agent activity</h1></div><div className="objective-meta"><span><i className="branch-icon">⑂</i> openfloor/session-presence</span><span>Started 24 min ago</span><div className="progress-ring"><b>62%</b></div></div></section>

      <div className={`workspace-grid ${expandedPanel ? "has-expanded" : ""}`} ref={workspaceRef}>
        {panelOrder.map((panel, index) => (
          <div className={`panel-slot ${expandedPanel === panel ? "maximized" : ""} ${draggedPanel === panel ? "dragging" : ""}`} style={{ flexBasis: `${panelWidths[panel]}%` }} key={panel} onDragOver={(event) => event.preventDefault()} onDrop={() => dropPanel(panel)}>
            {panels[panel]()}
            {index < panelOrder.length - 1 && !expandedPanel && <div className="resize-handle" role="separator" aria-label={`Resize ${panel} panel`} onPointerDown={(event) => startResize(panel, panelOrder[index + 1], event)} />}
          </div>
        ))}
      </div>

      <section className="collaboration-dock">
        <div className="collaboration-dock-inner">
          <div className="collaboration-heading"><div><span className="eyebrow">LIVE FLOOR</span><strong>{composerView === "all" ? "Everyone composing" : composerView === "you" ? "Your session input" : `${composerView.slice(0, 1).toUpperCase()}${composerView.slice(1)} is typing`}</strong></div><SegmentedControl label="Participant composer" value={composerView} onChange={(value) => setComposerView(value as ComposerView)} options={[{ value: "you", label: "You" }, { value: "matt", label: "Matt" }, { value: "ryan", label: "Ryan" }, { value: "ali", label: "Ali" }, { value: "all", label: "All" }]} /></div>
          <div className={`composer-stage ${composerView === "all" ? "show-all" : "show-one"}`}>
            {(composerView === "you" || composerView === "all") && userComposer(composerView === "all")}
            {liveScripts.map((draft, index) => (composerView === "all" || composerView === draft.name.toLowerCase()) ? teammateComposer(draft, index) : null)}
          </div>
        </div>
      </section>

      <div className="toast" role="status"><span>●</span>{notice}</div>
    </main>
  );
}
