"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentRun, FloorAgent, FloorAgentSettingsPatch, RunActivityEvent } from "@/lib/floor-types";
import { AGENT_PROVIDER_LABELS, credentialKindLabel, credentialKindsForProvider, parseCredentialKind, PROVIDER_MODELS } from "@/lib/provider-credentials";
import { BASE_PATH } from "@/components/basePath";
import { LocalDateTime } from "@/components/LocalDateTime";
import { HoverTip, Icon, useHoverTip } from "./primitives";
import { SelectMenu } from "./SelectMenu";
import type { RunActivitySource } from "./useRunActivity";
import { ACTIVE_RUN_STATUSES, agentReplyText, formatAgentCost, isRunLive, runStatusToken } from "./data";

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

export function AgentCard({ agent, tone, latestRun, activityEvents, selected, owner, onFocus, onHistory, onPause, onStop, onDelete }: { agent: FloorAgent; tone: string; latestRun: AgentRun | null; activityEvents: RunActivityEvent[]; selected: boolean; owner: boolean; onFocus: () => void; onHistory: () => void; onPause: (agentId: string, paused: boolean) => void; onStop: (agentId: string) => void; onDelete: (agentId: string) => void }) {
  const live = isRunLive(latestRun);
  const latestEvent = live ? activityEvents[activityEvents.length - 1] ?? null : null;
  const reply = agentReplyText(latestRun);
  const paused = agent.pausedAt !== null;
  const controllable = agent.kind !== "answer";
  const stateLabel = paused ? "Paused" : latestRun ? runStatusToken(latestRun).replace("_", " ") : "Created";
  const cost = formatAgentCost(agent);
  return (
    <article className="agent-card" data-selected={selected ? "true" : "false"} data-status={paused ? "paused" : latestRun ? runStatusToken(latestRun) : "idle"} data-tone={tone} role="button" tabIndex={0} onClick={onFocus} onKeyDown={(event) => {
      if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onFocus(); }
    }}>
      <div className="agent-head">
        <span className="agent-glyph" aria-hidden="true">{agent.name.slice(0, 1)}</span>
        <span className="agent-identity"><strong>{agent.name}{agent.kind && <em className="kind-tag" data-kind="auto">Auto-generated</em>}</strong><span>{agent.role}</span></span>
        <span className="agent-head-trailing"><span className="agent-state">{stateLabel}</span><button type="button" className="button agent-chat-button" data-size="sm" onClick={(event) => { event.stopPropagation(); onHistory(); }}><Icon name="message" size={12} /><span className="agent-chat-label">Prompts</span></button></span>
      </div>
      <div className="agent-task"><strong title={agent.task}>{agent.task}</strong></div>
      {latestEvent && (
        <div className="agent-activity-line" data-kind={latestEvent.kind} title={latestEvent.detail}>
          <span className="agent-activity-glyph" aria-hidden="true">{glyphFor(latestEvent.kind)}</span>
          <span className="agent-activity-detail">{latestEvent.detail}</span>
        </div>
      )}
      {reply && <AgentResponseIcon agentName={agent.name} reply={reply} onOpen={onFocus} />}
      {controllable && (
        <div className="agent-controls" onClick={(event) => event.stopPropagation()}>
          <button type="button" className="button" data-size="sm" title={paused ? "Resume" : "Pause"} aria-label={paused ? `Resume ${agent.name}` : `Pause ${agent.name}`} onClick={() => onPause(agent.id, !paused)}><Icon name={paused ? "play" : "pause"} size={12} /></button>
          <button type="button" className="button" data-size="sm" title={owner ? "Stop: pause future work and cancel the current run" : "Stop: pause future work; the current run will finish"} aria-label={`Stop ${agent.name}`} onClick={() => onStop(agent.id)}><Icon name="stop" size={12} /></button>
          {!agent.kind && <button type="button" className="button danger-button" data-size="sm" title="Delete" aria-label={`Delete ${agent.name}`} onClick={() => onDelete(agent.id)}><Icon name="trash" size={12} /></button>}
        </div>
      )}
      <div className="agent-foot"><span>Owned by {agent.ownerName}</span><span className="agent-cost" title={cost.title}>{cost.label}</span><span><LocalDateTime timestamp={agent.createdAt} /></span></div>
    </article>
  );
}

function AgentResponseIcon({ agentName, reply, onOpen }: { agentName: string; reply: string; onOpen: () => void }) {
  const tip = useHoverTip();
  return <>
    <button type="button" className="agent-response-icon" aria-label={`${agentName} responded: ${reply}. Open to read in full.`} onClick={(event) => { event.stopPropagation(); onOpen(); }} {...tip.handlers}><Icon name="message" size={13} /></button>
    <HoverTip position={tip.position} wrap>{reply}</HoverTip>
  </>;
}

export function AgentSpotlight({ agent, tone, sessionId, latestRun, activity, owner, onHistory, onUpdateSettings, onPause, onStop, onDelete }: { agent: FloorAgent; tone: string; sessionId: string; latestRun: AgentRun | null; activity: RunActivitySource; owner: boolean; onHistory: () => void; onUpdateSettings: (agentId: string, patch: FloorAgentSettingsPatch) => Promise<boolean>; onPause: (agentId: string, paused: boolean) => void; onStop: (agentId: string) => void; onDelete: (agentId: string) => void }) {
  // A reply run never runs checks, exports files, or publishes a branch —
  // that execution summary belongs only to a task run.
  const isReply = latestRun?.kind === "reply";
  const paused = agent.pausedAt !== null;
  const controllable = agent.kind !== "answer";
  const stateLabel = paused ? "Paused" : latestRun ? runStatusToken(latestRun).replace("_", " ") : "Created";
  return (
    <article className="spotlight" data-status={paused ? "paused" : latestRun ? runStatusToken(latestRun) : "idle"} data-tone={tone}>
      <div className="spotlight-head">
        <span className="agent-glyph" data-size="lg" aria-hidden="true">{agent.name.slice(0, 1)}</span>
        <div className="agent-identity"><h3>{agent.name}{agent.kind && <em className="kind-tag" data-kind="auto">Auto-generated</em>}</h3><span>{agent.role} · {AGENT_PROVIDER_LABELS[agent.provider]}{agent.model ? ` · ${agent.model}` : ""}{agent.credentialKind ? ` · ${credentialKindLabel(agent.provider, agent.credentialKind)}` : ""} · owned by {agent.ownerName}</span></div>
        <span className="agent-state">{stateLabel}</span>
      </div>
      {controllable && (
        <div className="agent-controls">
          <button type="button" className="button" data-size="sm" onClick={() => onPause(agent.id, !paused)}><Icon name={paused ? "play" : "pause"} size={12} />{paused ? "Resume" : "Pause"}</button>
          <button type="button" className="button" data-size="sm" title={owner ? "Pause future work and cancel the current run" : "Pause future work; the current run will finish"} onClick={() => onStop(agent.id)}><Icon name="stop" size={12} />Stop</button>
          {!agent.kind && <button type="button" className="button danger-button" data-size="sm" onClick={() => onDelete(agent.id)}><Icon name="trash" size={12} />Delete</button>}
        </div>
      )}
      <div className="spotlight-row"><span className="label">Task</span>{agent.kind ? <p className="agent-detail-line">{agent.task}</p> : <AgentTaskEditor key={`${agent.id}-${agent.updatedAt}`} agent={agent} onSave={(agentId, task) => onUpdateSettings(agentId, { task })} />}</div>
      {/* Same gate as the task editor: system-managed agents render read-only
          detail only. Both selects apply on change — the pattern this
          component already uses; no Apply-button form for two selects. */}
      {!agent.kind && (
        <div className="spotlight-row"><span className="label">Model</span>
          <SelectMenu
            label={`Model for ${agent.name}`}
            value={agent.model ?? "default"}
            onChange={(value) => {
              const model = value === "default" ? null : value;
              if (model !== agent.model) void onUpdateSettings(agent.id, { model });
            }}
            options={[
              { value: "default", label: "Provider default" },
              ...PROVIDER_MODELS[agent.provider].map((id) => ({ value: id, label: id })),
            ]}
          />
        </div>
      )}
      {!agent.kind && credentialKindsForProvider(agent.provider).length > 1 && (
        <div className="spotlight-row"><span className="label">Billing</span>
          <SelectMenu
            label={`Billing for ${agent.name}`}
            value={agent.credentialKind ?? "default"}
            onChange={(value) => {
              const kind = parseCredentialKind(value);
              if (kind !== agent.credentialKind) void onUpdateSettings(agent.id, { credentialKind: kind });
            }}
            options={[
              { value: "default", label: "Owner's default" },
              { value: "oauth", label: "Subscription" },
              { value: "api_key", label: "API key" },
            ]}
          />
        </div>
      )}
      {latestRun?.finalResponse && (
        <div className="spotlight-row"><span className="label">Response</span><div className="spotlight-response">{latestRun.finalResponse}</div></div>
      )}
      {!isReply && (
        <div className="spotlight-row"><span className="label">Execution</span>{latestRun ? <div className="spotlight-execution"><ActivityTimeline run={latestRun} activity={activity} /><p className="review-empty">{latestRun.files.length} changed file{latestRun.files.length === 1 ? "" : "s"}</p>{latestRun.runBranch && <p className="review-empty"><code>{latestRun.runBranch}</code>{latestRun.discardedAt ? " · discarded" : ""}{latestRun.rollbackStatus === "completed" ? " · rolled back" : ""}</p>}{latestRun.rollbackFailureReason && <p className="review-empty">{latestRun.rollbackFailureReason}</p>}<ArtifactToggle sessionId={sessionId} run={latestRun} label="Open raw log" closeLabel="Hide raw log" emptyText="The raw log becomes available when the run finishes." /><ArtifactToggle sessionId={sessionId} run={latestRun} kind="prompt" label="Session brief sent to this agent" closeLabel="Hide session brief" emptyText="The session brief becomes available once the run starts." /></div> : <p className="review-empty">No agent run has started.</p>}</div>
      )}
      {isReply && latestRun && (
        <div className="spotlight-row"><span className="label">Activity</span><div className="spotlight-execution"><ActivityTimeline run={latestRun} activity={activity} /><ArtifactToggle sessionId={sessionId} run={latestRun} kind="prompt" label="Session brief sent to this agent" closeLabel="Hide session brief" emptyText="The session brief becomes available once the run starts." /></div></div>
      )}
      <div className="spotlight-foot"><span><LocalDateTime timestamp={agent.createdAt} /></span><button type="button" className="button agent-chat-button" data-size="sm" onClick={onHistory}><Icon name="message" size={12} /><span className="agent-chat-label">Prompt history</span></button></div>
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
