"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { AppUser, TypingDraft } from "@/lib/session-types";
import type { FloorAgent, FloorParticipant } from "@/lib/floor-types";
import { visibleTypingDrafts, type DraftVisibility } from "@/lib/typing-drafts";
import { Avatar, Icon, SegmentedControl } from "./primitives";
import { AgentTargetMenu } from "./AgentTargetMenu";
import { MentionComposer } from "./MentionComposer";
import { StatusLine } from "./StatusLine";
import { initials } from "./data";

const draftVisibilityOptions: { value: DraftVisibility; label: string }[] = [
  { value: "all", label: "Everyone" },
  { value: "typing", label: "Typing" },
  { value: "hidden", label: "Hidden" },
];

export function FloorDock({ onSubmit, agents, queueTarget, onQueueTargetChange, textareaRef, notice, error, busy, user, participants, typingDrafts, onTypingUpdate }: {
  onSubmit: (value: string) => Promise<boolean>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  notice: string | null;
  error: string | null;
  agents: FloorAgent[];
  queueTarget: string | null;
  onQueueTargetChange: (id: string | null) => void;
  busy: boolean;
  user: AppUser;
  participants: FloorParticipant[];
  typingDrafts: ReadonlyMap<string, TypingDraft>;
  onTypingUpdate: (text: string, typing: boolean) => void;
}) {
  const target = agents.find((agent) => agent.id === queueTarget) ?? null;
  const [draftVisibility, setDraftVisibility] = useState<DraftVisibility>("typing");
  const idleTimerRef = useRef<number | null>(null);
  const latestDraftRef = useRef("");
  const teammates = useMemo(() => participants.filter((participant) => !participant.isCurrentUser), [participants]);
  const visibleDrafts = useMemo(
    () => visibleTypingDrafts(teammates, typingDrafts, draftVisibility),
    [draftVisibility, teammates, typingDrafts],
  );

  useEffect(() => () => {
    if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    onTypingUpdate("", false);
  }, [onTypingUpdate]);

  function updateDraft(text: string) {
    latestDraftRef.current = text;
    if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    onTypingUpdate(text, Boolean(text));
    if (text) {
      idleTimerRef.current = window.setTimeout(() => {
        onTypingUpdate(latestDraftRef.current, false);
      }, 1_800);
    }
  }

  async function submitPrompt() {
    const prompt = textareaRef.current?.value.trim() ?? "";
    if (!prompt || busy) return;
    if (await onSubmit(prompt)) {
      if (textareaRef.current) textareaRef.current.value = "";
      latestDraftRef.current = "";
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
      onTypingUpdate("", false);
    }
  }

  return <section className="dock" aria-label="Open floor" data-mode={draftVisibility}>
    {(notice || error) && <div className="dock-rail"><StatusLine notice={error ?? notice ?? ""} visible /></div>}
    <div className="dock-inner"><form className="composer" onSubmit={(event) => { event.preventDefault(); void submitPrompt(); }}>
      <div className="composer-head"><Avatar initials={initials(user.displayName)} tone="you" online /><div className="composer-who"><strong>{user.displayName}</strong><AgentTargetMenu value={queueTarget} onChange={onQueueTargetChange} agents={agents} /><span>{target ? `Queue for ${target.name}` : "Queue without an agent"}</span></div>{teammates.length > 0 && <div className="floor-presence"><span>Live drafts</span><div className="presence">{teammates.map((person) => <Avatar key={person.id} initials={person.initials} tone={person.tone} online={person.online} typing={typingDrafts.get(person.id)?.typing} />)}</div></div>}</div>
      <MentionComposer textareaRef={textareaRef} agents={agents} ariaLabel="Prompt to add to the queue" onValueChange={updateDraft} />
      <div className="composer-foot"><span className="value">Select an agent, use an exact @mention, or leave the prompt unassigned.</span><SegmentedControl label="Teammate drafts" value={draftVisibility} options={draftVisibilityOptions} onChange={setDraftVisibility} /><button type="submit" className="send" aria-label="Add to queue" title="Add to queue" disabled={busy}><span className="button-label send-label">{busy ? "Saving…" : "Add to queue"}</span><Icon name="send" /></button></div>
    </form>{visibleDrafts.map((person) => <div className="lane" key={person.id} data-typing={person.draft?.typing ? "true" : "false"} aria-label={`${person.name}'s draft`}><div className="lane-head"><Avatar initials={person.initials} tone={person.tone} online={person.online} typing={person.draft?.typing} /><strong>{person.name}</strong><em><Icon name="circle" size={6} />{person.draft?.typing ? "typing" : "idle"}</em></div>{person.draft?.text ? <p>{person.draft.text}</p> : <p />}</div>)}</div>
  </section>;
}
