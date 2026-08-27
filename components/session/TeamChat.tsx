"use client";

import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import type { FloorMessage, FloorParticipant, SessionFile } from "@/lib/floor-types";
import { BASE_PATH } from "@/components/basePath";
import { LocalDateTime } from "@/components/LocalDateTime";
import type { ChatThread } from "./data";
import { initials } from "./data";
import { Avatar, Icon } from "./primitives";
import { Markdown } from "./Markdown";

export function TeamChat({ messages, onSend, thread, onThreadChange, participants, currentUserId, sessionId, files = [], onUploadFiles }: {
  messages: FloorMessage[];
  onSend: (text: string, recipientUserId: string | null, attachmentIds?: string[]) => Promise<boolean>;
  thread?: ChatThread;
  onThreadChange?: (thread: ChatThread) => void;
  participants: FloorParticipant[];
  currentUserId: string;
  sessionId?: string;
  files?: SessionFile[];
  // Absent (e.g. the Review screen's embedded chat) hides the attach button;
  // already-sent attachments still render as chips.
  onUploadFiles?: (files: File[]) => Promise<string[] | null>;
}) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<File[]>([]);
  const [localThread, setLocalThread] = useState<ChatThread>("team");
  const activeThread = thread ?? localThread;
  const setThread = onThreadChange ?? setLocalThread;
  const listRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const teammate = participants.find((person) => person.id === activeThread);
  const visible = messages.filter((message) => activeThread === "team"
    ? message.recipientUserId === null
    : (message.authorUserId === currentUserId && message.recipientUserId === activeThread)
      || (message.authorUserId === activeThread && message.recipientUserId === currentUserId));
  const inputLabel = teammate ? `Message ${teammate.name}` : "Message the team";
  // Attachments are team-chat only (a DM attachment would surface in the
  // session-wide artifacts area) — the same rule the server enforces.
  const canAttach = activeThread === "team" && onUploadFiles !== undefined && sessionId !== undefined;

  useEffect(() => { if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight; }, [visible.length, activeThread]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    let attachmentIds: string[] | undefined;
    if (canAttach && pending.length > 0) {
      const uploaded = await onUploadFiles(pending);
      if (!uploaded) return;
      attachmentIds = uploaded;
    }
    if (await onSend(text, activeThread === "team" ? null : activeThread, attachmentIds)) {
      setDraft("");
      setPending([]);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
  }

  function attachmentsFor(messageId: string): SessionFile[] {
    return files.filter((file) => file.messageId === messageId);
  }

  return <div className="team-chat">
    <div className="team-chat-threads" role="group" aria-label="Chat thread"><button type="button" className="team-chat-thread" data-selected={activeThread === "team" ? "true" : "false"} aria-pressed={activeThread === "team"} onClick={() => setThread("team")}>Team</button>{participants.filter((person) => !person.isCurrentUser).map((person) => <button key={person.id} type="button" className="team-chat-thread" data-selected={activeThread === person.id ? "true" : "false"} aria-pressed={activeThread === person.id} onClick={() => setThread(person.id)}><Avatar userId={person.id} initials={person.initials} tone={person.tone} />{person.name}</button>)}</div>
    <div className="team-chat-list" ref={listRef}>{visible.length === 0 ? <p className="owner-detail-empty">No messages in this conversation.</p> : visible.map((message) => {
      const attached = attachmentsFor(message.id);
      return <div className="team-chat-message" key={message.id}><Avatar userId={message.authorUserId} initials={initials(message.authorName)} tone={message.authorUserId === currentUserId ? "you" : "member"} /><div className="team-chat-body"><div className="team-chat-head"><strong>{message.authorName}</strong><span><LocalDateTime timestamp={message.createdAt} /></span></div><Markdown className="chat-markdown">{message.text}</Markdown>{attached.length > 0 && sessionId && <ul className="composer-attachments" aria-label="Attachments">{attached.map((file) => <li key={file.id} className="attachment-chip"><Icon name="file" size={12} /><a href={`${BASE_PATH}/api/sessions/${sessionId}/files/${file.id}`} target="_blank" rel="noreferrer noopener">{file.name}</a></li>)}</ul>}</div></div>;
    })}</div>
    <form className="team-chat-composer" onSubmit={submit}>
      {canAttach && pending.length > 0 && <ul className="composer-attachments" aria-label="Files to attach">{pending.map((file, index) => <li key={`${file.name}-${index}`} className="attachment-chip"><Icon name="file" size={12} /><span>{file.name}</span><button type="button" aria-label={`Remove ${file.name}`} onClick={() => setPending((current) => current.filter((_, i) => i !== index))}><Icon name="close" size={9} /></button></li>)}</ul>}
      <div className="team-chat-composer-row">
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={handleKeyDown} aria-label={inputLabel} rows={1} maxLength={4000} />
        {canAttach && <>
          <input ref={fileInputRef} type="file" multiple style={{ display: "none" }} onChange={(event) => { const chosen = event.target.files; if (chosen?.length) setPending((current) => [...current, ...Array.from(chosen)]); event.target.value = ""; }} />
          <button type="button" className="icon-button" aria-label="Attach files or photos" title="Attach files or photos" onClick={() => fileInputRef.current?.click()}><Icon name="attach" /></button>
        </>}
        <button type="submit" className="icon-button" aria-label="Send message" title="Send"><Icon name="send" size={14} /></button>
      </div>
    </form>
  </div>;
}
