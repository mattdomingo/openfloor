"use client";

import { RefObject } from "react";
import type { AppUser } from "@/lib/session-types";
import { Agent, Check } from "./data";
import { Avatar, Icon } from "./primitives";
import { AttentionStrip } from "./AttentionStrip";
import { AgentTargetMenu } from "./AgentTargetMenu";
import { MentionComposer } from "./MentionComposer";
import { StatusLine } from "./StatusLine";

export function FloorDock({
  onSubmit,
  onNotice,
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
  user,
}: {
  onSubmit: (value: string) => void;
  onNotice: (notice: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onAnswer: (agent: Agent) => void;
  notice: string;
  agents: Agent[];
  checks: Check[];
  conflictResolved: boolean;
  onResolveConflict: () => void;
  onOpenChecks: () => void;
  routableAgents: Agent[];
  queueTarget: string | null;
  onQueueTargetChange: (id: string | null) => void;
  previewTargetAgent: Agent | null;
  user: AppUser;
}) {
  const askMode = previewTargetAgent?.kind === "qa";
  const targetCopy = previewTargetAgent ? previewTargetAgent.name : "OpenMind picks";

  function submitPrompt() {
    const prompt = textareaRef.current?.value ?? "";
    onSubmit(prompt);
    if (textareaRef.current) textareaRef.current.value = "";
  }

  return (
    <section className="dock" aria-label="Open floor">
      <div className="dock-rail">
        <AttentionStrip agents={agents} checks={checks} conflictResolved={conflictResolved} onResolveConflict={onResolveConflict} onOpenChecks={onOpenChecks} onNotice={onNotice} onAnswer={onAnswer} />
        <StatusLine notice={notice} visible />
      </div>
      <div className="dock-inner">
        <form className="composer" onSubmit={(event) => { event.preventDefault(); submitPrompt(); }}>
          <div className="composer-head">
            <Avatar initials={initials(user.displayName)} tone="you" online />
            <div className="composer-who">
              <strong>{user.displayName}</strong>
              <AgentTargetMenu value={queueTarget} onChange={onQueueTargetChange} agents={routableAgents} />
              <span>{askMode ? `Ask ${targetCopy}` : `Queue for ${targetCopy}`}</span>
            </div>
            <span className="prototype-composer-note">Local prototype queue</span>
          </div>
          <MentionComposer
            textareaRef={textareaRef}
            agents={routableAgents}
            placeholder={previewTargetAgent ? `Describe work to queue for ${targetCopy}…` : "Describe work, @mention an agent, or let OpenMind route it…"}
            ariaLabel={askMode ? "Question for Q" : "Prompt to add to the queue"}
          />
          <div className="composer-foot">
            <button type="button" className="button" data-size="sm" data-variant="quiet" aria-label="Attach context" onClick={() => onNotice("Repository attachments will connect with the agent backend") }>
              <Icon name="attach" size={12} /><span className="button-label">Attach context</span>
            </button>
            <button type="button" className="send" aria-label="Add to queue" title="Add to queue" onClick={submitPrompt}>
              <span className="button-label send-label">Add to queue</span><Icon name="send" />
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
}
