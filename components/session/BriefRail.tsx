"use client";

import { memo, useMemo, useRef, useState } from "react";
import type { FloorAgent, FloorAssignment, FloorMessage, FloorParticipant, FloorQueueItem, SessionFile } from "@/lib/floor-types";
import { formatSessionFileSize } from "@/lib/session-file-constraints";
import { BASE_PATH } from "@/components/basePath";
import type { ChatThread, TeamPanelView } from "./data";
import { Avatar, Icon, PersonName, SegmentedControl } from "./primitives";
import { Panel, type PanelChrome } from "./Rail";
import { TeamChat } from "./TeamChat";

type BriefRailProps = {
  chrome: PanelChrome;
  sessionId: string;
  assignments: FloorAssignment[];
  agents: FloorAgent[];
  queue: FloorQueueItem[];
  onAssignmentChange: (id: string, task: string | null) => Promise<boolean>;
  view: TeamPanelView;
  onViewChange: (view: TeamPanelView) => void;
  messages: FloorMessage[];
  onSendMessage: (text: string, recipientUserId: string | null, attachmentIds?: string[]) => Promise<boolean>;
  chatThread: ChatThread;
  onChatThreadChange: (thread: ChatThread) => void;
  participants: FloorParticipant[];
  currentUserId: string;
  unreadTeamCount: number;
  files: SessionFile[];
  onUploadFiles: (files: File[]) => Promise<string[] | null>;
};

// Every file shared into the session (ENG-113): chat attachments and direct
// uploads alike, all of it copied into each agent run's sandbox. Real rows
// from session_files — an empty session says so instead of inventing files.
const ArtifactsPanel = memo(function ArtifactsPanel({ sessionId, files, onUploadFiles }: {
  sessionId: string;
  files: SessionFile[];
  onUploadFiles: (files: File[]) => Promise<string[] | null>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="rail-section">
      <div className="rail-section-head">
        <span className="label">Artifacts</span>
        <span className="value">Shared with the team and every agent run</span>
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={async (event) => {
          const chosen = event.target.files ? Array.from(event.target.files) : [];
          event.target.value = "";
          if (chosen.length === 0) return;
          setBusy(true);
          await onUploadFiles(chosen);
          setBusy(false);
        }}
      />
      <button type="button" className="button" data-size="sm" onClick={() => inputRef.current?.click()} disabled={busy}>
        {busy ? "Uploading…" : "Add files"}
      </button>
      {files.length === 0 ? (
        <p className="owner-detail-empty">No files shared yet. Anything added here or attached in team chat lands in every agent&apos;s workspace.</p>
      ) : (
        <ul className="artifact-list">
          {[...files].reverse().map((file) => (
            <li key={file.id}>
              <a href={`${BASE_PATH}/api/sessions/${sessionId}/files/${file.id}`} target="_blank" rel="noreferrer noopener">
                <Icon name="file" size={12} />
                <span>{file.name}</span>
              </a>
              <small>{formatSessionFileSize(file.sizeBytes)} · {file.uploadedByName}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

const EMPTY_AGENTS: FloorAgent[] = [];
const EMPTY_PROMPTS: Array<{ item: FloorQueueItem; prompt: FloorQueueItem["prompts"][number] }> = [];

export const BriefRail = memo(function BriefRail(props: BriefRailProps) {
  const chatLabel = props.unreadTeamCount > 0
    ? <>Chat<span className="unread-badge">{props.unreadTeamCount}</span></>
    : "Chat";
  const controls = (
    <SegmentedControl
      label="Team panel view"
      value={props.view}
      onChange={props.onViewChange}
      options={[{ value: "goals", label: "Goals" }, { value: "chat", label: chatLabel }, { value: "artifacts", label: "Artifacts" }]}
    />
  );

  const agentsByOwner = useMemo(() => {
    const map = new Map<string, FloorAgent[]>();
    for (const agent of props.agents) {
      const list = map.get(agent.ownerUserId);
      if (list) {
        list.push(agent);
      } else {
        map.set(agent.ownerUserId, [agent]);
      }
    }
    return map;
  }, [props.agents]);

  const promptsByAuthor = useMemo(() => {
    const map = new Map<string, Array<{ item: FloorQueueItem; prompt: FloorQueueItem["prompts"][number] }>>();
    for (const item of props.queue) {
      for (const prompt of item.prompts) {
        const list = map.get(prompt.authorUserId);
        if (list) {
          list.push({ item, prompt });
        } else {
          map.set(prompt.authorUserId, [{ item, prompt }]);
        }
      }
    }
    return map;
  }, [props.queue]);

  const participantMap = useMemo(() => {
    return new Map(props.participants.map((person) => [person.id, person]));
  }, [props.participants]);

  return (
    <Panel chrome={props.chrome} title="Team" actions={controls}>
      {props.view === "chat" ? (
        <TeamChat
          messages={props.messages}
          onSend={props.onSendMessage}
          thread={props.chatThread}
          onThreadChange={props.onChatThreadChange}
          participants={props.participants}
          currentUserId={props.currentUserId}
          sessionId={props.sessionId}
          files={props.files}
          onUploadFiles={props.onUploadFiles}
        />
      ) : props.view === "artifacts" ? (
        <ArtifactsPanel sessionId={props.sessionId} files={props.files} onUploadFiles={props.onUploadFiles} />
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
                participant={participantMap.get(assignment.userId)}
                agents={agentsByOwner.get(assignment.userId) ?? EMPTY_AGENTS}
                prompts={promptsByAuthor.get(assignment.userId) ?? EMPTY_PROMPTS}
                onSave={props.onAssignmentChange}
              />
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
});

const OwnerCard = memo(function OwnerCard({ assignment, participant, agents, prompts, onSave }: {
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
          <strong><PersonName name={assignment.userName} /></strong>
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
});

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
