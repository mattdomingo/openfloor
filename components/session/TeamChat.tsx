"use client";

import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import type { FloorMessage, FloorParticipant } from "@/lib/floor-types";
import { LocalDateTime } from "@/components/LocalDateTime";
import type { ChatThread } from "./data";
import { initials } from "./data";
import { Avatar, Icon } from "./primitives";

export function TeamChat({ messages, onSend, thread, onThreadChange, participants, currentUserId }: {
  messages: FloorMessage[];
  onSend: (text: string, recipientUserId: string | null) => Promise<boolean>;
  thread?: ChatThread;
  onThreadChange?: (thread: ChatThread) => void;
  participants: FloorParticipant[];
  currentUserId: string;
}) {
  const [draft, setDraft] = useState("");
  const [localThread, setLocalThread] = useState<ChatThread>("team");
  const activeThread = thread ?? localThread;
  const setThread = onThreadChange ?? setLocalThread;
  const listRef = useRef<HTMLDivElement>(null);
  const teammate = participants.find((person) => person.id === activeThread);
  const visible = messages.filter((message) => activeThread === "team"
    ? message.recipientUserId === null
    : (message.authorUserId === currentUserId && message.recipientUserId === activeThread)
      || (message.authorUserId === activeThread && message.recipientUserId === currentUserId));
  const inputLabel = teammate ? `Message ${teammate.name}` : "Message the team";

  useEffect(() => { if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight; }, [visible.length, activeThread]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    if (await onSend(text, activeThread === "team" ? null : activeThread)) setDraft("");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
  }

  return <div className="team-chat">
    <div className="team-chat-threads" role="group" aria-label="Chat thread"><button type="button" className="team-chat-thread" data-selected={activeThread === "team" ? "true" : "false"} aria-pressed={activeThread === "team"} onClick={() => setThread("team")}>Team</button>{participants.filter((person) => !person.isCurrentUser).map((person) => <button key={person.id} type="button" className="team-chat-thread" data-selected={activeThread === person.id ? "true" : "false"} aria-pressed={activeThread === person.id} onClick={() => setThread(person.id)}><Avatar initials={person.initials} tone={person.tone} />{person.name}</button>)}</div>
    <div className="team-chat-list" ref={listRef}>{visible.length === 0 ? <p className="owner-detail-empty">No messages in this conversation.</p> : visible.map((message) => <div className="team-chat-message" key={message.id}><Avatar initials={initials(message.authorName)} tone={message.authorUserId === currentUserId ? "you" : "member"} /><div className="team-chat-body"><div className="team-chat-head"><strong>{message.authorName}</strong><span><LocalDateTime timestamp={message.createdAt} /></span></div><p>{message.text}</p></div></div>)}</div>
    <form className="team-chat-composer" onSubmit={submit}><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={handleKeyDown} aria-label={inputLabel} rows={1} maxLength={4000} /><button type="submit" className="icon-button" aria-label="Send message" title="Send"><Icon name="send" size={14} /></button></form>
  </div>;
}
