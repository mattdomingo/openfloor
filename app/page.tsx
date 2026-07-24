"use client";

import { FormEvent, useMemo, useState } from "react";

type AgentStatus = "running" | "reviewing" | "blocked" | "complete";

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
    time: "6m",
  },
  {
    id: "proof",
    name: "Proof",
    role: "Reviewer",
    task: "Integrated change review",
    owner: "Ollie",
    color: "#577590",
    status: "reviewing",
    progress: 41,
    detail: "Checking task boundaries and combined type safety",
    files: ["server/session/reducer.ts", "app/session/AgentCard.tsx"],
    time: "4m",
  },
];

const taskRows = [
  { id: "OF-17", title: "Define session event protocol", owner: "Atlas", state: "Active", tone: "orange" },
  { id: "OF-18", title: "Build agent activity cards", owner: "Nova", state: "Active", tone: "yellow" },
  { id: "OF-19", title: "Cover reducer transitions", owner: "Sentry", state: "Blocked", tone: "red" },
  { id: "OF-20", title: "Review integrated candidate", owner: "Proof", state: "Review", tone: "blue" },
  { id: "OF-21", title: "Add reconnect recovery", owner: "Unassigned", state: "Queued", tone: "gray" },
];

const fileRows = [
  { path: "server/events/schema.ts", agent: "Atlas", add: 84, del: 6, state: "modified" },
  { path: "server/session/reducer.ts", agent: "Atlas · Proof", add: 126, del: 18, state: "attention" },
  { path: "app/session/AgentCard.tsx", agent: "Nova · Proof", add: 192, del: 12, state: "modified" },
  { path: "app/session/activity.css", agent: "Nova", add: 77, del: 4, state: "modified" },
  { path: "tests/session-reducer.test.ts", agent: "Sentry", add: 63, del: 0, state: "pending" },
];

const activity = [
  { time: "10:42", actor: "Orchestrator", text: "narrowed Proof’s review scope", kind: "decision" },
  { time: "10:40", actor: "Proof", text: "requested access to session reducer", kind: "scope" },
  { time: "10:38", actor: "Atlas", text: "modified server/session/reducer.ts", kind: "file" },
  { time: "10:36", actor: "Ryan", text: "dispatched OF-18 to Nova", kind: "dispatch" },
];

function StatusDot({ status }: { status: AgentStatus }) {
  return <span className={`status-dot ${status}`} aria-hidden="true" />;
}

export default function Home() {
  const [agents, setAgents] = useState(initialAgents);
  const [selectedAgent, setSelectedAgent] = useState("atlas");
  const [conflictResolved, setConflictResolved] = useState(false);
  const [repoTab, setRepoTab] = useState<"changes" | "checks">("changes");
  const [fileFilter, setFileFilter] = useState<"all" | "attention">("all");
  const [dispatch, setDispatch] = useState("");
  const [notice, setNotice] = useState("Ollie joined · caught up from session state");

  const selected = agents.find((agent) => agent.id === selectedAgent) ?? agents[0];
  const visibleFiles = useMemo(
    () => fileRows.filter((file) => fileFilter === "all" || file.state === "attention"),
    [fileFilter],
  );

  function resolveConflict() {
    setConflictResolved(true);
    setAgents((current) =>
      current.map((agent) =>
        agent.id === "proof"
          ? { ...agent, detail: "Reviewing Atlas output read-only; no overlapping edits", progress: 55 }
          : agent,
      ),
    );
    setNotice("Scope resolved · Proof redirected to read-only review");
  }

  function submitTask(event: FormEvent) {
    event.preventDefault();
    const task = dispatch.trim();
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
        time: "now",
      },
    ]);
    setSelectedAgent(id);
    setDispatch("");
    setNotice(`Task dispatched · Orbit is planning “${task}”`);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
          <strong>OPENFLOOR</strong>
        </div>
        <div className="session-path">
          <span>Sessions</span><b>/</b><strong>Realtime presence</strong>
          <span className="live-pill"><i /> LIVE</span>
        </div>
        <div className="top-actions">
          <div className="participants" aria-label="Participants: Matt, Ryan, and Ollie">
            <span className="avatar coral">M</span>
            <span className="avatar yellow">R</span>
            <span className="avatar green">O</span>
          </div>
          <button className="invite-button" onClick={() => setNotice("Invite link copied to clipboard")}>+ Invite</button>
          <button className="icon-button" aria-label="Session menu">•••</button>
        </div>
      </header>

      <section className="objective-bar">
        <div>
          <span className="eyebrow">SESSION OBJECTIVE</span>
          <h1>Ship realtime presence and agent activity</h1>
        </div>
        <div className="objective-meta">
          <span><i className="branch-icon">⑂</i> openfloor/session-presence</span>
          <span>Started 24 min ago</span>
          <div className="progress-ring"><b>62%</b></div>
        </div>
      </section>

      <div className="workspace-grid">
        <aside className="tasks-panel panel">
          <div className="panel-heading">
            <div><span className="eyebrow">PLAN</span><h2>5 tasks</h2></div>
            <button className="small-button" onClick={() => setNotice("Plan view expanded")}>View plan</button>
          </div>
          <div className="task-list">
            {taskRows.map((task, index) => (
              <button className="task-row" key={task.id} onClick={() => setNotice(`${task.id} · ${task.title}`)}>
                <span className="task-track"><i className={`task-node ${task.tone}`} />{index < taskRows.length - 1 && <i className="task-line" />}</span>
                <span className="task-copy">
                  <span className="task-id">{task.id}</span>
                  <strong>{task.title}</strong>
                  <span>{task.owner}</span>
                </span>
                <span className={`state-tag ${task.tone}`}>{task.state}</span>
              </button>
            ))}
          </div>
          <div className="decision-card">
            <span className="eyebrow">LATEST DECISION</span>
            <strong>WebSocket reconnects replay from the last acknowledged event.</strong>
            <span>Decided by Matt · 8m ago</span>
          </div>
        </aside>

        <section className="agents-panel panel">
          <div className="panel-heading agents-heading">
            <div><span className="eyebrow">ACTIVE FLOOR</span><h2>{agents.filter((a) => a.status !== "complete").length} agents working</h2></div>
            <div className="pulse-label"><i /> Events flowing</div>
          </div>

          {!conflictResolved ? (
            <div className="conflict-banner">
              <div className="conflict-icon">!</div>
              <div><span className="eyebrow">PLANNED SCOPE CONFLICT</span><strong>Atlas and Proof both claim <code>server/session/reducer.ts</code></strong><p>The orchestrator recommends keeping Atlas as owner and making Proof’s pass read-only.</p></div>
              <button onClick={resolveConflict}>Apply resolution</button>
            </div>
          ) : (
            <div className="resolved-banner"><span>✓</span><strong>Scope resolved</strong><p>Atlas owns the reducer. Proof will review its patch read-only.</p></div>
          )}

          <div className="agent-grid">
            {agents.map((agent) => (
              <button
                key={agent.id}
                className={`agent-card ${selectedAgent === agent.id ? "selected" : ""}`}
                onClick={() => setSelectedAgent(agent.id)}
                style={{ "--agent-color": agent.color } as React.CSSProperties}
              >
                <div className="agent-topline">
                  <span className="agent-glyph">{agent.name.slice(0, 1)}</span>
                  <span className="agent-name"><strong>{agent.name}</strong><small>{agent.role}</small></span>
                  <span className="agent-status"><StatusDot status={agent.status} />{agent.status}</span>
                </div>
                <div className="agent-task"><span>{agent.task}</span><strong>{agent.progress}%</strong></div>
                <div className="progress-track"><i style={{ width: `${agent.progress}%` }} /></div>
                <p>{agent.detail}</p>
                <div className="agent-files"><span>⌘</span><span>{agent.files[0]}</span>{agent.files.length > 1 && <b>+{agent.files.length - 1}</b>}</div>
                <div className="agent-footer"><span>Launched by {agent.owner}</span><span>{agent.time}</span></div>
              </button>
            ))}
          </div>

          <div className="agent-detail">
            <div className="detail-header">
              <div className="agent-glyph large" style={{ background: selected.color }}>{selected.name.slice(0, 1)}</div>
              <div><span className="eyebrow">FOCUSED AGENT</span><h3>{selected.name} · {selected.task}</h3></div>
              <button className="small-button" onClick={() => setNotice(`${selected.name} has been asked for a status update`)}>Ask for update</button>
            </div>
            <div className="detail-steps">
              <span className="done"><i>✓</i>Read contract</span><span className="done"><i>✓</i>Claim scope</span><span className="active"><i>3</i>Implement</span><span><i>4</i>Run checks</span><span><i>5</i>Prepare patch</span>
            </div>
          </div>
        </section>

        <aside className="repo-panel panel">
          <div className="panel-heading">
            <div><span className="eyebrow">COMBINED STATE</span><h2>Candidate branch</h2></div>
            <span className="sync-state"><i /> Synced</span>
          </div>
          <div className="repo-summary">
            <div><strong>5</strong><span>files changed</span></div>
            <div><strong className="add">+542</strong><span>additions</span></div>
            <div><strong className="del">−40</strong><span>deletions</span></div>
          </div>
          <div className="tabs" role="tablist">
            <button className={repoTab === "changes" ? "active" : ""} onClick={() => setRepoTab("changes")}>Changes</button>
            <button className={repoTab === "checks" ? "active" : ""} onClick={() => setRepoTab("checks")}>Checks <span>3/4</span></button>
          </div>
          {repoTab === "changes" ? (
            <>
              <div className="file-filter">
                <button className={fileFilter === "all" ? "active" : ""} onClick={() => setFileFilter("all")}>All files</button>
                <button className={fileFilter === "attention" ? "active" : ""} onClick={() => setFileFilter("attention")}>Needs attention</button>
              </div>
              <div className="file-list">
                {visibleFiles.map((file) => (
                  <button className="file-row" key={file.path} onClick={() => setNotice(`Opening combined diff for ${file.path}`)}>
                    <span className={`file-state ${file.state}`}>{file.state === "attention" ? "!" : file.state === "pending" ? "◷" : "M"}</span>
                    <span className="file-copy"><strong>{file.path.split("/").pop()}</strong><small>{file.path.split("/").slice(0, -1).join("/")} · {file.agent}</small></span>
                    <span className="diff-stat"><i className="add">+{file.add}</i><i className="del">−{file.del}</i></span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="checks-list">
              <div><span className="check-pass">✓</span><p><strong>Type check</strong><small>Passed · 32s</small></p></div>
              <div><span className="check-pass">✓</span><p><strong>Unit tests</strong><small>48 passed · 1m 14s</small></p></div>
              <div><span className="check-pass">✓</span><p><strong>Lint</strong><small>No warnings · 18s</small></p></div>
              <div><span className="check-wait">◷</span><p><strong>Integration suite</strong><small>Waiting on OF-19</small></p></div>
            </div>
          )}
          <div className="integration-card">
            <div><span className="eyebrow">INTEGRATION ORDER</span><b>1</b> Atlas <span>→</span> <b>2</b> Nova <span>→</span> <b>3</b> Sentry</div>
            <button onClick={() => setNotice("Combined diff ready for review")}>Review combined diff <span>↗</span></button>
          </div>
        </aside>
      </div>

      <section className="command-dock">
        <div className="activity-strip">
          <span className="eyebrow">SESSION PULSE</span>
          <div className="activity-items">
            {activity.slice(0, 3).map((item) => <span key={item.time}><b>{item.actor}</b> {item.text} <time>{item.time}</time></span>)}
          </div>
          <button onClick={() => setNotice("Activity history opened")}>Full history</button>
        </div>
        <form className="dispatch-form" onSubmit={submitTask}>
          <span className="prompt-glyph">⌁</span>
          <input value={dispatch} onChange={(event) => setDispatch(event.target.value)} placeholder="Dispatch a task or steer the session…" aria-label="Dispatch a task or steer the session" />
          <div className="dispatch-tools"><button type="button" onClick={() => setNotice("Attach repository context")}>⌘</button><span>Session context on</span><button type="submit" className="send-button" aria-label="Dispatch task">↑</button></div>
        </form>
      </section>

      <div className="toast" role="status"><span>●</span>{notice}</div>
    </main>
  );
}
