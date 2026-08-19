"use client";

import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import type { FloorParticipant } from "@/lib/floor-types";
import { ChatThread, TeamChatMessage } from "./data";
import { Avatar, Icon } from "./primitives";

export function TeamChat({
  messages,
  onSend,
  thread,
  onThreadChange,
  participants,
}: {
  messages: TeamChatMessage[];
  onSend: (text: string, thread: ChatThread) => void;
  thread?: ChatThread;
  onThreadChange?: (thread: ChatThread) => void;
  participants: FloorParticipant[];
}) {
  const [draft, setDraft] = useState("");
  /* Fallback for mounts that don't control the thread (the review screen). */
  const [localThread, setLocalThread] = useState<ChatThread>("team");
  const activeThread = thread ?? localThread;
  const setThread = onThreadChange ?? setLocalThread;
  const listRef = useRef<HTMLDivElement>(null);

  const teammate = participants.find((person) => person.id === activeThread);
  const visible = messages.filter((message) =>
    activeThread === "team" ? !message.dmWith : message.dmWith === activeThread,
  );
  const placeholder = teammate ? `Message ${teammate.name} privately…` : "Message the team…";

  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [visible.length, activeThread]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    onSend(text, activeThread);
    setDraft("");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <div className="team-chat">
      <div className="team-chat-threads" role="group" aria-label="Chat thread">
        <button
          type="button"
          className="team-chat-thread"
          data-selected={activeThread === "team" ? "true" : "false"}
          aria-pressed={activeThread === "team"}
          onClick={() => setThread("team")}
        >
          Team
        </button>
        {participants.map((person) => (
          <button
            key={person.id}
            type="button"
            className="team-chat-thread"
            data-selected={activeThread === person.id ? "true" : "false"}
            aria-pressed={activeThread === person.id}
            onClick={() => setThread(person.id)}
          >
            <Avatar initials={person.initials} tone={person.tone} />
            {person.name}
          </button>
        ))}
      </div>

      <div className="team-chat-list" ref={listRef}>
        {visible.map((message) => (
          <div className="team-chat-message" key={message.id}>
            <Avatar initials={message.authorName.slice(0, 1)} tone={message.authorTone} />
            <div className="team-chat-body">
              <div className="team-chat-head">
                <strong>{message.authorName}</strong>
                <span>{message.time}</span>
              </div>
              <p>{message.text}</p>
            </div>
          </div>
        ))}
      </div>

      <form className="team-chat-composer" onSubmit={submit}>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          aria-label={placeholder}
          rows={1}
        />
        <button type="submit" className="icon-button" aria-label="Send message" title="Send">
          <Icon name="send" size={14} />
        </button>
      </form>
    </div>
  );
}
