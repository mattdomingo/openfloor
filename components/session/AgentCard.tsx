"use client";

import { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { Agent, agentKindLabel, autonomyLabel, planSteps, statusAlert, statusLabel } from "./data";
import { Icon, StatusDot, Stepper } from "./primitives";

function agentStyle(agent: Agent) {
  return { "--agent-color": agent.color } as CSSProperties;
}

export function AgentCard({
  agent,
  selected,
  onFocus,
  onHistory,
}: {
  agent: Agent;
  selected: boolean;
  onFocus: () => void;
  onHistory: () => void;
}) {
  function openHistory(event: ReactMouseEvent) {
    event.stopPropagation();
    onHistory();
  }

  function onKeyDown(event: ReactKeyboardEvent) {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onFocus();
  }

  return (
    <article
      className="agent-card"
      data-selected={selected ? "true" : "false"}
      data-status={agent.status}
      style={agentStyle(agent)}
      role="button"
      tabIndex={0}
      onClick={onFocus}
      onKeyDown={onKeyDown}
    >
      <div className="agent-head">
        <span className="agent-glyph" aria-hidden="true">
          {agent.name.slice(0, 1)}
        </span>
        <span className="agent-identity">
          <strong>
            {agent.name}
            {agent.kind !== "worker" && (
              <span className="kind-tag" data-kind={agent.kind}>
                {agentKindLabel(agent)}
              </span>
            )}
          </strong>
          <span>{agent.role}</span>
        </span>
        <span className="agent-head-trailing">
          <span className="agent-state">
            <StatusDot status={agent.status} />
            {statusLabel(agent.status)}
          </span>
          <button
            type="button"
            className="button agent-chat-button"
            data-size="sm"
            aria-label={`View ${agent.name}'s chat history`}
            title="Chat history"
            onClick={openHistory}
          >
            <Icon name="message" size={12} />
            Chat
          </button>
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

      {agent.kind === "worker" && (
        <>
          <div className="agent-scope">
            <Icon name="file" size={12} />
            <span>{agent.files[0]}</span>
            {agent.files.length > 1 && <b>+{agent.files.length - 1}</b>}
          </div>

          <Stepper steps={planSteps(agent)} compact />
        </>
      )}

      <div className="agent-foot">
        <span>
          Launched by {agent.owner} · {agent.time}
        </span>
      </div>
    </article>
  );
}

/* The callout at the top of a focused agent, explaining what that agent is waiting on. */
function AgentAlert({
  agent,
  onNotice,
  onAnswer,
}: {
  agent: Agent;
  onNotice: (notice: string) => void;
  onAnswer: (agent: Agent) => void;
}) {
  const alert = statusAlert(agent);
  if (!alert) return null;

  /* Answering happens in the composer, not in a toast. */
  const act = agent.status === "needs-input" ? () => onAnswer(agent) : () => onNotice(alert.notice);

  return (
    <div className="agent-alert" data-status={agent.status} role="status">
      <Icon name="alert" size={14} />
      <div className="agent-alert-body">
        <strong>{alert.title}</strong>
        <p>{alert.body}</p>
      </div>
      <button type="button" className="button" data-size="sm" onClick={act}>
        {alert.action}
      </button>
    </div>
  );
}

export function AgentSpotlight({
  agent,
  onNotice,
  onHistory,
  onAnswer,
}: {
  agent: Agent;
  onNotice: (notice: string) => void;
  onHistory: () => void;
  onAnswer: (agent: Agent) => void;
}) {
  return (
    <article className="spotlight" data-status={agent.status} style={agentStyle(agent)}>
      <AgentAlert agent={agent} onNotice={onNotice} onAnswer={onAnswer} />

      <div className="spotlight-head">
        <span className="agent-glyph" data-size="lg" aria-hidden="true">
          {agent.name.slice(0, 1)}
        </span>
        <div className="agent-identity">
          <h3>
            {agent.name} · {agent.task}
            {agent.kind !== "worker" && (
              <span className="kind-tag" data-kind={agent.kind}>
                {agentKindLabel(agent)}
              </span>
            )}
          </h3>
          <span>
            {agent.role} · launched by {agent.owner}
          </span>
        </div>
        <span className="agent-state">
          <StatusDot status={agent.status} />
          {statusLabel(agent.status)}
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

      {agent.kind === "worker" && (
        <>
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
        </>
      )}

      <div className="spotlight-row">
        <span className="label">Configuration</span>
        <div className="config-list">
          <span>{agent.model}</span>
          <span>{autonomyLabel(agent.autonomy)}</span>
          <span>
            {agent.checks.length} {agent.checks.length === 1 ? "check" : "checks"} before patch
          </span>
          <span>{agent.reviewRequired ? "Review required" : "Review optional"}</span>
          <span>from {agent.baseBranch}</span>
        </div>
      </div>

      <div className="spotlight-foot">
        <span className="value">
          <Icon name="branch" size={12} />
          {agent.branch}
        </span>
        <span>{agent.time} ago</span>
        <button type="button" className="button agent-chat-button" data-size="sm" onClick={onHistory}>
          <Icon name="message" size={12} />
          Chat history
        </button>
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
