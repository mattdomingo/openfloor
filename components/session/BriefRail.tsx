"use client";

import { CSSProperties, useState } from "react";
import { Agent, Assignment, ChatThread, QueueItem, TeamChatMessage, TeamPanelView, latestDecision, statusLabel } from "./data";
import { Avatar, Icon, SegmentedControl } from "./primitives";
import { Panel, PanelChrome } from "./Rail";
import { TeamChat } from "./TeamChat";

export function BriefRail({
  chrome,
  assignments,
  agents,
  queue,
  onAssignmentChange,
  onNotice,
  view,
  onViewChange,
  messages,
  onSendMessage,
  chatThread,
  onChatThreadChange,
}: {
  chrome: PanelChrome;
  assignments: Assignment[];
  agents: Agent[];
  queue: QueueItem[];
  onAssignmentChange: (id: string, task: string) => void;
  onNotice: (notice: string) => void;
  view: TeamPanelView;
  onViewChange: (view: TeamPanelView) => void;
  messages: TeamChatMessage[];
  onSendMessage: (text: string, thread: ChatThread) => void;
  chatThread: ChatThread;
  onChatThreadChange: (thread: ChatThread) => void;
}) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  function toggleExpanded(id: string) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const controls = (
    <SegmentedControl
      label="Team panel view"
      value={view}
      onChange={onViewChange}
      options={[
        { value: "goals", label: "Goals" },
        { value: "chat", label: "Chat" },
      ]}
    />
  );

  /* No meta line on this panel: Goals/Chat leaves the head too tight for one,
     and the roster below already answers "how many people". */
  return (
    <Panel chrome={chrome} title="Team" badge={`${assignments.length}`} actions={controls}>
      {view === "chat" ? (
        <TeamChat messages={messages} onSend={onSendMessage} thread={chatThread} onThreadChange={onChatThreadChange} />
      ) : (
        <>
          <div className="rail-section">
            <div className="rail-section-head">
              <span className="label">Ownership</span>
              <span className="value">Editable by everyone</span>
            </div>
            <div className="owner-list">
              {assignments.map((assignment) => {
                const expanded = expandedIds.has(assignment.id);
                const spawnedAgents = agents.filter((agent) => agent.owner === assignment.name);
                const pastPrompts = queue.filter((item) => item.author === assignment.name);

                return (
                  <div className="owner-card" key={assignment.id} data-expanded={expanded ? "true" : "false"}>
                    <button
                      type="button"
                      className="owner-card-toggle"
                      aria-expanded={expanded}
                      onClick={() => toggleExpanded(assignment.id)}
                    >
                      <Avatar initials={assignment.initials} tone={assignment.tone} />
                      <span className="owner-head">
                        <strong>{assignment.name}</strong>
                        <span className="state-tag" data-tone={assignment.stateTone}>
                          {assignment.state}
                        </span>
                      </span>
                      <Icon name="chevronDown" size={12} className="owner-card-chevron" />
                    </button>

                    <textarea
                      value={assignment.task}
                      aria-label={`Assignment for ${assignment.name}`}
                      onChange={(event) => onAssignmentChange(assignment.id, event.target.value)}
                      onBlur={() => onNotice(`${assignment.name}'s assignment updated for everyone`)}
                    />

                    {expanded && (
                      <div className="owner-detail">
                        <div className="owner-detail-section">
                          <span className="label">Agents spun up</span>
                          {spawnedAgents.length === 0 ? (
                            <p className="owner-detail-empty">Hasn&apos;t launched an agent yet.</p>
                          ) : (
                            <ul className="owner-agent-list">
                              {spawnedAgents.map((spawned) => (
                                <li key={spawned.id}>
                                  <span
                                    className="agent-glyph"
                                    aria-hidden="true"
                                    style={{ "--agent-color": spawned.color } as CSSProperties}
                                  >
                                    {spawned.name.slice(0, 1)}
                                  </span>
                                  <span className="owner-agent-copy">
                                    <strong>{spawned.name}</strong>
                                    <span>
                                      {spawned.role} · {statusLabel(spawned.status)}
                                    </span>
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>

                        <div className="owner-detail-section">
                          <span className="label">Past prompts</span>
                          {pastPrompts.length === 0 ? (
                            <p className="owner-detail-empty">No prompts sent yet.</p>
                          ) : (
                            <ul className="owner-prompt-list">
                              {pastPrompts.map((item) => (
                                <li key={item.id}>
                                  <div className="owner-prompt-head">
                                    <span className="value">→ {item.agentName}</span>
                                    <span>{item.queuedAt}</span>
                                  </div>
                                  <p>{item.prompt}</p>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="rail-section">
            <div className="rail-section-head">
              <span className="label">Latest decision</span>
            </div>
            <div className="decision">
              <strong>{latestDecision.statement}</strong>
              <span>{latestDecision.attribution}</span>
            </div>
          </div>
        </>
      )}
    </Panel>
  );
}
