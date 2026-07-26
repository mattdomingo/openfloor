"use client";

import { CSSProperties } from "react";
import { Agent, planSteps } from "./data";
import { Icon, StatusDot, Stepper } from "./primitives";

function agentStyle(agent: Agent) {
  return { "--agent-color": agent.color } as CSSProperties;
}

export function AgentCard({ agent, selected, onFocus }: { agent: Agent; selected: boolean; onFocus: () => void }) {
  return (
    <article className="agent-card" data-selected={selected ? "true" : "false"} style={agentStyle(agent)}>
      <div className="agent-head">
        <span className="agent-glyph" aria-hidden="true">
          {agent.name.slice(0, 1)}
        </span>
        <span className="agent-identity">
          <strong>{agent.name}</strong>
          <span>{agent.role}</span>
        </span>
        <span className="agent-state">
          <StatusDot status={agent.status} />
          {agent.status}
        </span>
      </div>

      <div>
        <div className="agent-task">
          <strong>{agent.task}</strong>
          <span>{agent.progress}%</span>
        </div>
        <div className="progress-track">
          <i style={{ width: `${agent.progress}%` }} />
        </div>
      </div>

      <p className="agent-detail-line">{agent.detail}</p>

      <div className="agent-scope">
        <Icon name="file" size={12} />
        <span>{agent.files[0]}</span>
        {agent.files.length > 1 && <b>+{agent.files.length - 1}</b>}
      </div>

      <Stepper steps={planSteps(agent)} compact />

      <div className="agent-foot">
        <span>
          Launched by {agent.owner} · {agent.time}
        </span>
        <button type="button" className="button" data-size="sm" data-variant="quiet" onClick={onFocus}>
          Focus
        </button>
      </div>
    </article>
  );
}

export function AgentSpotlight({ agent, onNotice }: { agent: Agent; onNotice: (notice: string) => void }) {
  return (
    <article className="spotlight" style={agentStyle(agent)}>
      <div className="spotlight-head">
        <span className="agent-glyph" data-size="lg" aria-hidden="true">
          {agent.name.slice(0, 1)}
        </span>
        <div className="agent-identity">
          <h3>
            {agent.name} · {agent.task}
          </h3>
          <span>
            {agent.role} · launched by {agent.owner}
          </span>
        </div>
        <span className="agent-state">
          <StatusDot status={agent.status} />
          {agent.status}
        </span>
      </div>

      <div className="spotlight-progress">
        <div className="progress-track">
          <i style={{ width: `${agent.progress}%` }} />
        </div>
        <span>{agent.progress}%</span>
      </div>

      <div className="spotlight-row">
        <span className="label">Current step</span>
        <p className="agent-detail-line">{agent.detail}</p>
      </div>

      <div className="spotlight-row">
        <span className="label">Plan</span>
        <Stepper steps={planSteps(agent)} />
      </div>

      <div className="spotlight-row">
        <span className="label">Write scope</span>
        <div className="scope-list">
          {agent.files.map((file) => (
            <code key={file}>{file}</code>
          ))}
        </div>
      </div>

      <div className="spotlight-foot">
        <span className="value">
          <Icon name="branch" size={12} />
          {agent.branch}
        </span>
        <span>{agent.time} ago</span>
        <button
          type="button"
          className="button"
          data-size="sm"
          onClick={() => onNotice(`${agent.name} has been asked for a status update`)}
        >
          Ask for update
        </button>
      </div>
    </article>
  );
}
