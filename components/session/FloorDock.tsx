"use client";

import { FormEvent, RefObject, useEffect } from "react";
import { Agent, Check, Draft, DockMode, participants } from "./data";
import { Avatar, Icon, SegmentedControl } from "./primitives";
import { AttentionStrip } from "./AttentionStrip";
import { AgentTargetMenu } from "./AgentTargetMenu";
import { MentionComposer } from "./MentionComposer";
import { StatusLine } from "./StatusLine";

export type FloorLane = Draft & { text: string; typing: boolean };

const dockModeOptions: { value: DockMode; label: string }[] = [
  { value: "focus", label: "Focus" },
  { value: "persistent", label: "Everyone" },
  { value: "live", label: "Typing" },
];

export function FloorDock({
  value,
  onChange,
  onSubmit,
  onNotice,
  dockMode,
  onDockModeChange,
  lanes,
  typingIds,
  agents,
  checks,
  conflictResolved,
  onResolveConflict,
  onOpenChecks,
  routableAgents,
  queueTarget,
  onQueueTargetChange,
  previewTargetAgent,
  textareaRef,
  onAnswer,
  notice,
  noticeVisible,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onNotice: (notice: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onAnswer: (agent: Agent) => void;
  notice: string;
  noticeVisible: boolean;
  dockMode: DockMode;
  onDockModeChange: (mode: DockMode) => void;
  lanes: FloorLane[];
  typingIds: Set<string>;
  agents: Agent[];
  checks: Check[];
  conflictResolved: boolean;
  onResolveConflict: () => void;
  onOpenChecks: () => void;
  routableAgents: Agent[];
  queueTarget: string | null;
  onQueueTargetChange: (id: string | null) => void;
  previewTargetAgent: Agent | null;
}) {
  const askMode = previewTargetAgent?.kind === "qa";

  useEffect(() => {
    if (dockMode === "focus") textareaRef.current?.focus();
  }, [dockMode, textareaRef]);

  const targetCopy = previewTargetAgent ? previewTargetAgent.name : "OpenMind picks";

  return (
    <section className="dock" aria-label="Open floor" data-mode={dockMode}>
      {/* Alerts and the running status share a reserved band above the
          composer, so neither ever sits on top of the workspace. */}
      <div className="dock-rail">
        <AttentionStrip
          agents={agents}
          checks={checks}
          conflictResolved={conflictResolved}
          onResolveConflict={onResolveConflict}
          onOpenChecks={onOpenChecks}
          onNotice={onNotice}
          onAnswer={onAnswer}
        />
        <StatusLine notice={notice} visible={noticeVisible} />
      </div>

      <div className="dock-inner">
        <form className="composer" onSubmit={onSubmit}>
          <div className="composer-head">
            <Avatar initials="Y" tone="you" />
            <div className="composer-who">
              <strong>You</strong>
              <AgentTargetMenu value={queueTarget} onChange={onQueueTargetChange} agents={routableAgents} />
              <span>{askMode ? `Ask ${targetCopy}` : `Queue for ${targetCopy}`}</span>
            </div>
            <div className="floor-presence">
              <span>Drafting on the floor</span>
              <div className="presence">
                {participants.map((person) => (
                  <Avatar key={person.id} initials={person.initials} tone={person.tone} typing={typingIds.has(person.id)} />
                ))}
              </div>
            </div>
          </div>

          <MentionComposer
            value={value}
            onChange={onChange}
            textareaRef={textareaRef}
            agents={routableAgents}
            placeholder={
              askMode
                ? `Ask ${targetCopy} a question…`
                : previewTargetAgent
                  ? `Describe work to queue for ${targetCopy}…`
                  : "Describe work, @mention an agent, or let OpenMind route it…"
            }
            ariaLabel={askMode ? "Question for Q" : "Prompt to add to the queue"}
          />

          <div className="composer-foot">
            <button
              type="button"
              className="button"
              data-size="sm"
              data-variant="quiet"
              aria-label="Attach context"
              onClick={() => onNotice("Attach repository context")}
            >
              <Icon name="attach" size={12} />
              <span className="button-label">Attach context</span>
            </button>
            <SegmentedControl label="Teammate drafts" value={dockMode} options={dockModeOptions} onChange={onDockModeChange} />
            <button type="submit" className="send" aria-label={askMode ? "Ask" : "Add to queue"} title={askMode ? "Ask" : "Add to queue"}>
              <span className="button-label send-label">{askMode ? "Ask" : "Add to queue"}</span>
              <Icon name="send" />
            </button>
          </div>
        </form>

        {dockMode !== "focus" &&
          lanes.map((lane) => (
            <div
              className="lane"
              key={lane.id}
              data-typing={lane.typing ? "true" : "false"}
              aria-label={lane.typing ? `${lane.name} is typing` : `${lane.name}'s last message`}
            >
              <div className="lane-head">
                <Avatar initials={lane.initials} tone={lane.tone} typing={lane.typing} />
                <strong>{lane.name}</strong>
                <em>
                  <Icon name="circle" size={6} />
                  {lane.typing ? "typing" : "idle"}
                </em>
              </div>
              <p>{lane.text}</p>
            </div>
          ))}
      </div>
    </section>
  );
}
