"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { TypingDraft } from "@/lib/session-types";
import type { FloorAgent, FloorParticipant } from "@/lib/floor-types";
import { visibleTypingDrafts, type DraftVisibility } from "@/lib/typing-drafts";
import { Avatar, Icon, SegmentedControl } from "./primitives";
import { AgentTargetMenu } from "./AgentTargetMenu";
import { MentionComposer } from "./MentionComposer";
import { StatusLine } from "./StatusLine";

// `title` doubles as the accessible name (kept as the original word, e.g.
// "Typing") — existing tests locate these buttons by that name.
const draftVisibilityOptions: { value: DraftVisibility; label: ReactNode; title: string }[] = [
  { value: "all", label: <Icon name="eye" size={13} />, title: "Everyone" },
  { value: "typing", label: <Icon name="pencil" size={13} />, title: "Typing" },
  { value: "hidden", label: <Icon name="eyeOff" size={13} />, title: "Hidden" },
];

export function FloorDock({ onSubmit, onUploadFiles, agents, queueTarget, onQueueTargetChange, textareaRef, notice, noticeTone, noticeVisible, busy, participants, typingDrafts, onTypingUpdate }: {
  onSubmit: (value: string) => Promise<boolean>;
  onUploadFiles: (files: File[]) => Promise<string[] | null>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  notice: string | null;
  noticeTone: "notice" | "error";
  noticeVisible: boolean;
  agents: FloorAgent[];
  queueTarget: string | null;
  onQueueTargetChange: (id: string | null) => void;
  busy: boolean;
  participants: FloorParticipant[];
  typingDrafts: ReadonlyMap<string, TypingDraft>;
  onTypingUpdate: (text: string, typing: boolean) => void;
}) {
  const [draftVisibility, setDraftVisibility] = useState<DraftVisibility>("typing");
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const idleTimerRef = useRef<number | null>(null);
  const latestDraftRef = useRef("");
  const fileInputRef = useRef<HTMLInputElement>(null);
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
    setValue(text);
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
    const prompt = value.trim();
    if (busy) return;
    // Attachments land in the session's shared files (the Team panel's
    // Artifacts view) and every later agent run's sandbox — they aren't tied
    // to this one prompt. Uploading works with or without prompt text.
    if (attachments.length > 0) {
      if (!(await onUploadFiles(attachments))) return;
      setAttachments([]);
    }
    if (!prompt) return;
    if (await onSubmit(prompt)) {
      setValue("");
      // Clear the DOM node itself, not just React state: a slow render can
      // otherwise leave the stale value on screen for a beat after submit.
      if (textareaRef.current) textareaRef.current.value = "";
      latestDraftRef.current = "";
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
      onTypingUpdate("", false);
    }
  }

  function addAttachments(files: FileList | null) {
    if (!files || files.length === 0) return;
    setAttachments((current) => [...current, ...Array.from(files)]);
  }

  function removeAttachment(index: number) {
    setAttachments((current) => current.filter((_, i) => i !== index));
  }

  return <section className="dock" aria-label="Open floor" data-mode={draftVisibility}>
    {/* Floats above the dock instead of reserving a permanent band — only
        takes space while there's something to say, and only for as long as
        useTransientNotice keeps `notice` non-null (dwell, then a fade before
        unmount — see StatusLine's data-visible exit transition). */}
    {notice && <div className="dock-toast" data-visible={noticeVisible ? "true" : "false"}><StatusLine notice={notice} visible={noticeVisible} tone={noticeTone} /></div>}
    <div className="dock-inner"><form className="composer" onSubmit={(event) => { event.preventDefault(); void submitPrompt(); }}>
      {teammates.length > 0 && <div className="composer-head"><div className="floor-presence"><span>Live drafts</span><div className="presence">{teammates.map((person) => <Avatar key={person.id} userId={person.id} initials={person.initials} tone={person.tone} online={person.online} typing={typingDrafts.get(person.id)?.typing} />)}</div></div></div>}
      <MentionComposer textareaRef={textareaRef} agents={agents} ariaLabel="Prompt to add to the queue" value={value} onValueChange={updateDraft} />
      {attachments.length > 0 && <ul className="composer-attachments" aria-label="Attached files">{attachments.map((file, index) => <li key={`${file.name}-${index}`} className="attachment-chip"><Icon name="file" size={12} /><span>{file.name}</span><button type="button" aria-label={`Remove ${file.name}`} onClick={() => removeAttachment(index)}><Icon name="close" size={9} /></button></li>)}</ul>}
      <div className="composer-foot">
        <AgentTargetMenu value={queueTarget} onChange={onQueueTargetChange} agents={agents} />
        <SegmentedControl label="Teammate drafts" value={draftVisibility} options={draftVisibilityOptions} onChange={setDraftVisibility} />
        <input ref={fileInputRef} type="file" multiple style={{ display: "none" }} onChange={(event) => { addAttachments(event.target.files); event.target.value = ""; }} />
        <button type="button" className="icon-button" aria-label="Attach files or photos" title="Attach files or photos" onClick={() => fileInputRef.current?.click()}><Icon name="attach" /></button>
        <button type="submit" className="send" aria-label="Add to queue" title="Add to queue" disabled={busy}><span className="button-label send-label">{busy ? "Saving…" : "Add to queue"}</span><Icon name="send" /></button>
      </div>
    </form>{visibleDrafts.length > 0 && <div className="dock-lanes">{visibleDrafts.map((person) => <div className="lane" key={person.id} data-typing={person.draft?.typing ? "true" : "false"} aria-label={`${person.name}'s draft`}><div className="lane-head"><Avatar userId={person.id} initials={person.initials} tone={person.tone} online={person.online} typing={person.draft?.typing} /><strong>{person.name}</strong><em><Icon name="circle" size={6} />{person.draft?.typing ? "typing" : "idle"}</em></div>{person.draft?.text ? <p>{person.draft.text}</p> : <p />}</div>)}</div>}</div>
  </section>;
}
