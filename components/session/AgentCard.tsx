"use client";

import type { AgentRun, FloorAgent } from "@/lib/floor-types";
import { formatShortDate, formatShortTime } from "@/lib/date-format";
import { Icon } from "./primitives";
import { agentTone } from "./data";

export function AgentCard({ agent, latestRun, selected, onFocus, onHistory }: { agent: FloorAgent; latestRun: AgentRun | null; selected: boolean; onFocus: () => void; onHistory: () => void }) {
  return (
    <article className="agent-card" data-selected={selected ? "true" : "false"} data-status={latestRun?.status ?? "idle"} data-tone={agentTone(agent.id)} role="button" tabIndex={0} onClick={onFocus} onKeyDown={(event) => {
      if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onFocus(); }
    }}>
      <div className="agent-head">
        <span className="agent-glyph" aria-hidden="true">{agent.name.slice(0, 1)}</span>
        <span className="agent-identity"><strong>{agent.name}</strong><span>{agent.role}</span></span>
        <span className="agent-head-trailing"><span className="agent-state">{latestRun?.status.replace("_", " ") ?? "Created"}</span><button type="button" className="button agent-chat-button" data-size="sm" onClick={(event) => { event.stopPropagation(); onHistory(); }}><Icon name="message" size={12} />Prompts</button></span>
      </div>
      <div className="agent-task"><strong>{agent.task}</strong></div>
      <div className="agent-foot"><span>Owned by {agent.ownerName}</span><span>{formatShortDate(agent.createdAt)} · {formatShortTime(agent.createdAt)} UTC</span></div>
    </article>
  );
}

export function AgentSpotlight({ agent, latestRun, onHistory }: { agent: FloorAgent; latestRun: AgentRun | null; onHistory: () => void }) {
  return (
    <article className="spotlight" data-status={latestRun?.status ?? "idle"} data-tone={agentTone(agent.id)}>
      <div className="spotlight-head">
        <span className="agent-glyph" data-size="lg" aria-hidden="true">{agent.name.slice(0, 1)}</span>
        <div className="agent-identity"><h3>{agent.name}</h3><span>{agent.role} · owned by {agent.ownerName}</span></div>
        <span className="agent-state">{latestRun?.status.replace("_", " ") ?? "Created"}</span>
      </div>
      <div className="spotlight-row"><span className="label">Task</span><p className="agent-detail-line">{agent.task}</p></div>
      <div className="spotlight-row"><span className="label">Execution</span>{latestRun ? <div><p>{latestRun.summary ?? `Run is ${latestRun.status.replace("_", " ")}.`}</p><p className="review-empty">{latestRun.files.length} changed file{latestRun.files.length === 1 ? "" : "s"} · {latestRun.checks.filter((check) => check.status === "passed").length}/{latestRun.checks.length} checks passed</p>{latestRun.runBranch && <p className="review-empty"><code>{latestRun.runBranch}</code>{latestRun.discardedAt ? " · discarded" : ""}</p>}</div> : <p className="review-empty">No agent run has started.</p>}</div>
      <div className="spotlight-foot"><span>{formatShortDate(agent.createdAt)} · {formatShortTime(agent.createdAt)} UTC</span><button type="button" className="button agent-chat-button" data-size="sm" onClick={onHistory}><Icon name="message" size={12} />Prompt history</button></div>
    </article>
  );
}
