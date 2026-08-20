"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentRun, FloorAgent, RunActivityEvent } from "@/lib/floor-types";
import { BASE_PATH } from "@/components/basePath";
import { LocalDateTime } from "@/components/LocalDateTime";
import { Icon } from "./primitives";
import { agentTone } from "./data";
import type { RunActivitySource } from "./useRunActivity";

const ACTIVE_RUN_STATUSES = new Set(["provisioning", "running", "checking", "publishing", "integrating", "cancel_requested"]);

const KIND_GLYPHS: Record<string, string> = {
  reasoning: "✳",
  command: "$",
  file_edit: "±",
  agent_message: "◆",
  tool_call: "⟲",
  error: "!",
  truncated: "…",
};

function glyphFor(kind: string): string {
  return KIND_GLYPHS[kind] ?? "•";
}

export function AgentCard({ agent, latestRun, activityEvents, selected, onFocus, onHistory }: { agent: FloorAgent; latestRun: AgentRun | null; activityEvents: RunActivityEvent[]; selected: boolean; onFocus: () => void; onHistory: () => void }) {
  const latestEvent = latestRun && ACTIVE_RUN_STATUSES.has(latestRun.status) ? activityEvents[activityEvents.length - 1] ?? null : null;
  return (
    <article className="agent-card" data-selected={selected ? "true" : "false"} data-status={latestRun?.status ?? "idle"} data-tone={agentTone(agent.id)} role="button" tabIndex={0} onClick={onFocus} onKeyDown={(event) => {
      if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onFocus(); }
    }}>
      <div className="agent-head">
        <span className="agent-glyph" aria-hidden="true">{agent.name.slice(0, 1)}</span>
        <span className="agent-identity"><strong>{agent.name}</strong><span>{agent.role}</span></span>
        <span className="agent-head-trailing"><span className="agent-state">{latestRun?.status.replace("_", " ") ?? "Created"}</span><button type="button" className="button agent-chat-button" data-size="sm" onClick={(event) => { event.stopPropagation(); onHistory(); }}><Icon name="message" size={12} />Prompts</button></span>
      </div>
      <div className="agent-task"><strong title={agent.task}>{agent.task}</strong></div>
      {latestEvent && (
        <div className="agent-activity-line" data-kind={latestEvent.kind} title={latestEvent.detail}>
          <span className="agent-activity-glyph" aria-hidden="true">{glyphFor(latestEvent.kind)}</span>
          <span className="agent-activity-detail">{latestEvent.detail}</span>
        </div>
      )}
      <div className="agent-foot"><span>Owned by {agent.ownerName}</span><span><LocalDateTime timestamp={agent.createdAt} /></span></div>
    </article>
  );
}

export function AgentSpotlight({ agent, sessionId, latestRun, activity, onHistory, onUpdateTask }: { agent: FloorAgent; sessionId: string; latestRun: AgentRun | null; activity: RunActivitySource; onHistory: () => void; onUpdateTask: (agentId: string, task: string) => Promise<boolean> }) {
  return (
    <article className="spotlight" data-status={latestRun?.status ?? "idle"} data-tone={agentTone(agent.id)}>
      <div className="spotlight-head">
        <span className="agent-glyph" data-size="lg" aria-hidden="true">{agent.name.slice(0, 1)}</span>
        <div className="agent-identity"><h3>{agent.name}</h3><span>{agent.role} · owned by {agent.ownerName}</span></div>
        <span className="agent-state">{latestRun?.status.replace("_", " ") ?? "Created"}</span>
      </div>
      <div className="spotlight-row"><span className="label">Task</span><AgentTaskEditor key={`${agent.id}-${agent.updatedAt}`} agent={agent} onSave={onUpdateTask} /></div>
      <div className="spotlight-row"><span className="label">Execution</span>{latestRun ? <div className="spotlight-execution"><ActivityTimeline run={latestRun} activity={activity} /><p className="review-empty">{latestRun.files.length} changed file{latestRun.files.length === 1 ? "" : "s"} · {latestRun.checks.filter((check) => check.status === "passed").length}/{latestRun.checks.length} checks passed</p>{latestRun.runBranch && <p className="review-empty"><code>{latestRun.runBranch}</code>{latestRun.discardedAt ? " · discarded" : ""}</p>}<ArtifactToggle sessionId={sessionId} run={latestRun} label="Open raw log" closeLabel="Hide raw log" emptyText="The raw log becomes available when the run finishes." /><ArtifactToggle sessionId={sessionId} run={latestRun} kind="prompt" label="Session brief sent to this agent" closeLabel="Hide session brief" emptyText="The session brief becomes available once the run starts." /></div> : <p className="review-empty">No agent run has started.</p>}</div>
      <div className="spotlight-foot"><span><LocalDateTime timestamp={agent.createdAt} /></span><button type="button" className="button agent-chat-button" data-size="sm" onClick={onHistory}><Icon name="message" size={12} />Prompt history</button></div>
    </article>
  );
}

function ActivityTimeline({ run, activity }: { run: AgentRun; activity: RunActivitySource }) {
  const events = activity.eventsFor(run.id);
  const listRef = useRef<HTMLOListElement>(null);
  const pinnedRef = useRef(true);
  const loadTimeline = activity.loadTimeline;

  useEffect(() => { loadTimeline(run.id); }, [loadTimeline, run.id]);

  useEffect(() => {
    const list = listRef.current;
    if (list && pinnedRef.current) list.scrollTop = list.scrollHeight;
  }, [events.length]);

  if (events.length === 0) {
    return <p className="review-empty">{run.summary ?? `Run is ${run.status.replace("_", " ")}.`}</p>;
  }
  const live = ACTIVE_RUN_STATUSES.has(run.status);
  return (
    <ol className="spotlight-activity" data-live={live ? "true" : "false"} ref={listRef} aria-label={`Activity for ${run.status.replace("_", " ")} run`} onScroll={(event) => {
      const list = event.currentTarget;
      pinnedRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    }}>
      {events.map((event) => (
        <li key={event.sequence} className="spotlight-activity-row" data-kind={event.kind}>
          <span className="agent-activity-glyph" aria-hidden="true">{glyphFor(event.kind)}</span>
          {event.kind === "command" || event.kind === "file_edit"
            ? <code className="agent-activity-detail">{event.detail}</code>
            : <span className="agent-activity-detail">{event.detail}</span>}
        </li>
      ))}
    </ol>
  );
}

/** Fetch-on-expand artifact viewer. Omit `kind` for the default (unfiltered) codex_log + diff view. */
function ArtifactToggle({ sessionId, run, kind, label, closeLabel, emptyText }: {
  sessionId: string; run: AgentRun; kind?: string; label: string; closeLabel: string; emptyText: string;
}) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function toggle() {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (content !== null || loading) return;
    setLoading(true);
    try {
      const url = `${BASE_PATH}/api/sessions/${sessionId}/runs/${run.id}/artifacts${kind ? `?kind=${kind}` : ""}`;
      const response = await fetch(url, { cache: "no-store" });
      setContent(response.ok ? await response.text() : "");
    } catch {
      setContent("");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="agent-raw-log">
      <button type="button" className="button" data-size="sm" onClick={() => void toggle()} aria-expanded={open}>{open ? closeLabel : label}</button>
      {open && (loading
        ? <p className="review-empty">Loading…</p>
        : content
          ? <pre className="agent-raw-log-output">{content}</pre>
          : <p className="review-empty">{emptyText}</p>)}
    </div>
  );
}

function AgentTaskEditor({ agent, onSave }: { agent: FloorAgent; onSave: (agentId: string, task: string) => Promise<boolean> }) {
  const [value, setValue] = useState(agent.task);
  return (
    <textarea
      className="agent-detail-line agent-task-editor"
      value={value}
      aria-label={`Task for ${agent.name}`}
      maxLength={1000}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => {
        const normalized = value.trim();
        if (normalized && normalized !== agent.task) void onSave(agent.id, normalized);
        else if (!normalized) setValue(agent.task);
      }}
    />
  );
}
