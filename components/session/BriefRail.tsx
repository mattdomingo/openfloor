"use client";

import { useState } from "react";
import type { FloorAgent, FloorAssignment, FloorMessage, FloorParticipant, FloorQueueItem } from "@/lib/floor-types";
import type { ChatThread, TeamPanelView } from "./data";
import { Avatar, Icon, SegmentedControl } from "./primitives";
import { Panel, type PanelChrome } from "./Rail";
import { TeamChat } from "./TeamChat";

type BriefRailProps = {
  chrome: PanelChrome;
  assignments: FloorAssignment[];
  agents: FloorAgent[];
  queue: FloorQueueItem[];
  onAssignmentChange: (id: string, task: string | null) => Promise<boolean>;
  view: TeamPanelView;
  onViewChange: (view: TeamPanelView) => void;
  messages: FloorMessage[];
  onSendMessage: (text: string, recipientUserId: string | null) => Promise<boolean>;
  chatThread: ChatThread;
  onChatThreadChange: (thread: ChatThread) => void;
  participants: FloorParticipant[];
  currentUserId: string;
};

export function BriefRail(props: BriefRailProps) {
  const controls = (
    <SegmentedControl
      label="Team panel view"
      value={props.view}
      onChange={props.onViewChange}
      options={[{ value: "goals", label: "Goals" }, { value: "chat", label: "Chat" }]}
    />
  );

  return (
    <Panel chrome={props.chrome} title="Team" badge={`${props.assignments.length}`} actions={controls}>
      {props.view === "chat" ? (
        <TeamChat
          messages={props.messages}
          onSend={props.onSendMessage}
          thread={props.chatThread}
          onThreadChange={props.onChatThreadChange}
          participants={props.participants}
          currentUserId={props.currentUserId}
        />
      ) : (
        <div className="rail-section">
          <div className="rail-section-head">
            <span className="label">Assignments</span>
            <span className="value">Shared with the session</span>
          </div>
          <div className="owner-list">
            {props.assignments.map((assignment) => (
              <OwnerCard
                key={assignment.userId}
                assignment={assignment}
                participant={props.participants.find((person) => person.id === assignment.userId)}
                agents={props.agents.filter((agent) => agent.ownerUserId === assignment.userId)}
                prompts={props.queue.flatMap((item) => item.prompts.map((prompt) => ({ item, prompt }))).filter(({ prompt }) => prompt.authorUserId === assignment.userId)}
                onSave={props.onAssignmentChange}
              />
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}

function OwnerCard({ assignment, participant, agents, prompts, onSave }: {
  assignment: FloorAssignment;
  participant?: FloorParticipant;
  agents: FloorAgent[];
  prompts: Array<{ item: FloorQueueItem; prompt: FloorQueueItem["prompts"][number] }>;
  onSave: (id: string, task: string | null) => Promise<boolean>;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="owner-card" data-expanded={expanded ? "true" : "false"}>
      <button type="button" className="owner-card-toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <Avatar userId={participant?.id} initials={participant?.initials ?? "?"} tone={participant?.tone ?? "member"} online={participant?.online} />
        <span className="owner-head">
          <strong title={assignment.userName}>{assignment.userName}</strong>
          <span className="state-tag" data-tone={participant?.online ? "running" : "waiting"}>{participant?.online ? "Online" : "Offline"}</span>
        </span>
        <Icon name="chevronDown" size={12} className="owner-card-chevron" />
      </button>
      <AssignmentEditor key={`${assignment.userId}-${assignment.updatedAt ?? "empty"}`} assignment={assignment} onSave={onSave} />
      {expanded && (
        <div className="owner-detail">
          <div className="owner-detail-section">
            <span className="label">Agents</span>
            {agents.length === 0 ? <p className="owner-detail-empty">No agents owned.</p> : (
              <ul className="owner-agent-list">
                {agents.map((agent) => (
                  <li key={agent.id}>
                    <span className="agent-glyph" aria-hidden="true">{agent.name.slice(0, 1)}</span>
                    <span className="owner-agent-copy"><strong>{agent.name}</strong><span>{agent.role} · created</span></span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="owner-detail-section">
            <span className="label">Prompts submitted</span>
            {prompts.length === 0 ? <p className="owner-detail-empty">No prompts submitted.</p> : (
              <ul className="owner-prompt-list">
                {prompts.map(({ item, prompt }) => (
                  <li key={prompt.id}>
                    <div className="owner-prompt-head"><span className="value">To {item.agentName ?? "Unassigned"}</span></div>
                    <p>{prompt.text}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function AssignmentEditor({ assignment, onSave }: { assignment: FloorAssignment; onSave: (id: string, task: string | null) => Promise<boolean> }) {
  const [value, setValue] = useState(assignment.task ?? "");
  return (
    <textarea
      value={value}
      aria-label={`Assignment for ${assignment.userName}`}
      maxLength={2000}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => {
        const normalized = value.trim() || null;
        if (normalized !== assignment.task) void onSave(assignment.userId, normalized);
      }}
    />
  );
}
