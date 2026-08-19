"use client";

import type { RefObject } from "react";
import type { AppUser } from "@/lib/session-types";
import type { FloorAgent } from "@/lib/floor-types";
import { Avatar, Icon } from "./primitives";
import { AgentTargetMenu } from "./AgentTargetMenu";
import { MentionComposer } from "./MentionComposer";
import { StatusLine } from "./StatusLine";
import { initials } from "./data";

export function FloorDock({ onSubmit, agents, queueTarget, onQueueTargetChange, textareaRef, notice, error, busy, user }: {
  onSubmit: (value: string) => Promise<boolean>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  notice: string | null;
  error: string | null;
  agents: FloorAgent[];
  queueTarget: string | null;
  onQueueTargetChange: (id: string | null) => void;
  busy: boolean;
  user: AppUser;
}) {
  const target = agents.find((agent) => agent.id === queueTarget) ?? null;

  async function submitPrompt() {
    const prompt = textareaRef.current?.value.trim() ?? "";
    if (!prompt || busy) return;
    if (await onSubmit(prompt)) {
      if (textareaRef.current) textareaRef.current.value = "";
    }
  }

  return <section className="dock" aria-label="Open floor">
    {(notice || error) && <div className="dock-rail"><StatusLine notice={error ?? notice ?? ""} visible /></div>}
    <div className="dock-inner"><form className="composer" onSubmit={(event) => { event.preventDefault(); void submitPrompt(); }}>
      <div className="composer-head"><Avatar initials={initials(user.displayName)} tone="you" online /><div className="composer-who"><strong>{user.displayName}</strong><AgentTargetMenu value={queueTarget} onChange={onQueueTargetChange} agents={agents} /><span>{target ? `Queue for ${target.name}` : "Queue without an agent"}</span></div></div>
      <MentionComposer textareaRef={textareaRef} agents={agents} ariaLabel="Prompt to add to the queue" />
      <div className="composer-foot"><span className="value">Select an agent, use an exact @mention, or leave the prompt unassigned.</span><button type="submit" className="send" aria-label="Add to queue" title="Add to queue" disabled={busy}><span className="button-label send-label">{busy ? "Saving…" : "Add to queue"}</span><Icon name="send" /></button></div>
    </form></div>
  </section>;
}
