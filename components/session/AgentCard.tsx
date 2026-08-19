"use client";

import type { FloorAgent } from "@/lib/floor-types";
import { LocalDateTime } from "@/components/LocalDateTime";
import { Icon } from "./primitives";
import { agentTone } from "./data";

export function AgentCard({ agent, selected, onFocus, onHistory }: { agent: FloorAgent; selected: boolean; onFocus: () => void; onHistory: () => void }) {
  return (
    <article className="agent-card" data-selected={selected ? "true" : "false"} data-status="idle" data-tone={agentTone(agent.id)} role="button" tabIndex={0} onClick={onFocus} onKeyDown={(event) => {
      if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onFocus(); }
    }}>
      <div className="agent-head">
        <span className="agent-glyph" aria-hidden="true">{agent.name.slice(0, 1)}</span>
        <span className="agent-identity"><strong>{agent.name}</strong><span>{agent.role}</span></span>
        <span className="agent-head-trailing"><span className="agent-state">Created</span><button type="button" className="button agent-chat-button" data-size="sm" onClick={(event) => { event.stopPropagation(); onHistory(); }}><Icon name="message" size={12} />Prompts</button></span>
      </div>
      <div className="agent-task"><strong>{agent.task}</strong></div>
      <div className="agent-foot"><span>Owned by {agent.ownerName}</span><span><LocalDateTime timestamp={agent.createdAt} /></span></div>
    </article>
  );
}

export function AgentSpotlight({ agent, onHistory }: { agent: FloorAgent; onHistory: () => void }) {
  return (
    <article className="spotlight" data-status="idle" data-tone={agentTone(agent.id)}>
      <div className="spotlight-head">
        <span className="agent-glyph" data-size="lg" aria-hidden="true">{agent.name.slice(0, 1)}</span>
        <div className="agent-identity"><h3>{agent.name}</h3><span>{agent.role} · owned by {agent.ownerName}</span></div>
        <span className="agent-state">Created</span>
      </div>
      <div className="spotlight-row"><span className="label">Task</span><p className="agent-detail-line">{agent.task}</p></div>
      <div className="spotlight-row"><span className="label">Execution</span><p className="review-empty">No runtime is connected. Progress, files, and output will appear here only when reported by a real agent backend.</p></div>
      <div className="spotlight-foot"><span><LocalDateTime timestamp={agent.createdAt} /></span><button type="button" className="button agent-chat-button" data-size="sm" onClick={onHistory}><Icon name="message" size={12} />Prompt history</button></div>
    </article>
  );
}
